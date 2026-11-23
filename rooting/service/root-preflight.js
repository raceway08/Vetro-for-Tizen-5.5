'use strict';
// Read-only platform checks and per-install archive signing support.
// Tizen 5.5 has .NET Core 3.0 behind Samsung's signed dotnet-launcher,
// while newer supported TVs use the dotnet muxer.
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function failure(code) {
    var error = new Error(code);
    error.code = code;
    return error;
}

function selectRuntime(versions) {
    if (versions.some(function (version) { return version[0] >= 6; })) return '6.0';
    if (versions.some(function (version) { return version[0] === 3 && version[1] === 1; })) return '3.1';
    if (versions.some(function (version) { return version[0] === 3 && version[1] === 0; })) return '3.0';
    throw failure('runtime-unsupported');
}

function fileExists(files, file) {
    try {
        if (typeof files.existsSync === 'function') return files.existsSync(file);
        files.accessSync(file);
        return true;
    } catch (error) {
        return false;
    }
}

function runtimeFromActiveLink(files) {
    var active = '/usr/share/dotnet.tizen/netcoreapp';
    try {
        var target = files.realpathSync(active);
        var match = /^(\d+)\.(\d+)\.\d+$/.exec(path.basename(target));
        if (!match) throw failure('runtime-probe-failed');
        files.accessSync(active + '/libcoreclr.so');
        files.accessSync(active + '/System.Private.CoreLib.dll');
        return selectRuntime([[Number(match[1]), Number(match[2])]]);
    } catch (error) {
        if (error.code === 'runtime-unsupported') throw error;
        throw failure('runtime-probe-failed');
    }
}

function detectRuntime(result, files) {
    if (result && result.ok) {
        var versions = [], match;
        var pattern = /^Microsoft\.NETCore\.App (\d+)\.(\d+)\.\d+\s+\[/gm;
        while ((match = pattern.exec(result.output))) versions.push([Number(match[1]), Number(match[2])]);
        return selectRuntime(versions);
    }
    if (files && result
        && ((result.code === 255 && result.output.indexOf('Unknown option --list-runtimes') >= 0)
            || result.code === 127)) {
        return runtimeFromActiveLink(files);
    }
    throw failure('runtime-probe-failed');
}

function effectiveCapabilities(output, file, required) {
    var line = output.split('\n').filter(function (entry) {
        return entry.split(/\s+/)[0] === file;
    })[0] || '';
    var capabilities = {}, match;
    var pattern = /(cap_[a-z0-9_]+(?:,cap_[a-z0-9_]+)*)[=+]([eip]+)/g;
    while ((match = pattern.exec(line))) {
        match[1].split(',').forEach(function (name) { capabilities[name] = match[2]; });
    }
    return required.every(function (name) {
        return (capabilities[name] || '').indexOf('e') >= 0;
    });
}

function checkTarget(options) {
    var opts = options || {};
    var execute = opts.run;
    var files = opts.fs || fs;
    if (typeof execute !== 'function') return Promise.reject(failure('preflight-failed'));

    var hasMuxer = fileExists(files, '/usr/bin/dotnet');
    var runtimePromise = hasMuxer
        ? execute('/usr/bin/dotnet', ['--list-runtimes']).then(function (result) {
            return detectRuntime(result, files);
        })
        : Promise.resolve().then(function () { return runtimeFromActiveLink(files); });

    return runtimePromise.then(function (runtime) {
        var hostFile = hasMuxer ? '/usr/bin/dotnet' : '/usr/bin/dotnet-launcher';
        var hostCommand = hasMuxer ? '/usr/bin/dotnet' : '/usr/bin/dotnet-launcher --standalone';
        if (!hasMuxer && runtime !== '3.0') throw failure('dotnet-host-missing');
        if (!fileExists(files, hostFile)) {
            throw failure(runtime === '3.0' ? 'tizen55-launcher-missing' : 'dotnet-host-missing');
        }
        return execute('getcap', [hostFile, '/usr/sbin/sdbd-tarlauncher']).then(function (caps) {
            if (!caps.ok) throw failure('capabilities-probe-failed');
            if (!effectiveCapabilities(caps.output, hostFile, ['cap_setgid', 'cap_sys_admin'])) {
                throw failure('dotnet-capabilities-missing');
            }
            if (!effectiveCapabilities(caps.output, '/usr/sbin/sdbd-tarlauncher', ['cap_setgid', 'cap_setuid'])) {
                throw failure('launcher-capabilities-missing');
            }
            return execute('/usr/bin/tar', ['--help']).then(function (tar) {
                if (!tar.ok) throw failure('tar-probe-failed');
                if (tar.output.indexOf('--to-command') < 0) throw failure('tar-unsupported');
                return {
                    runtime: runtime,
                    hostFile: hostFile,
                    hostCommand: hostCommand,
                    source: 'detected'
                };
            });
        });
    });
}

function quote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// Generate an ephemeral per-start key on the TV. Node 4.4 has createSign()
// but not generateKeyPairSync(); using the TV's OpenSSL avoids embedding a
// shared private key in the signed WGT. The private key is deleted after it is
// read into the service process and is never written to the Vetro state file.
function createSigningKeyPair(run) {
    if (typeof run !== 'function') return Promise.reject(failure('key-generation-failed'));
    return run('/bin/sh', ['-c', 'command -v openssl']).then(function (found) {
        if (!found.ok) throw failure('openssl-unavailable');
        var openssl = String(found.output || '').trim().split('\n')[0];
        if (!/^\/[A-Za-z0-9_./-]+\/openssl$/.test(openssl)) throw failure('openssl-unavailable');

        var token = crypto.randomBytes(8).toString('hex');
        var privatePath = '/tmp/vetro-sign-' + token + '.key';
        var publicPath = '/tmp/vetro-sign-' + token + '.pub';
        var script = 'umask 077 && ' + quote(openssl) + ' genrsa -out ' + quote(privatePath) + ' 2048'
            + ' && ' + quote(openssl) + ' rsa -in ' + quote(privatePath) + ' -pubout -out ' + quote(publicPath);

        function cleanup() {
            return run('/bin/rm', ['-f', privatePath, publicPath]).then(function () {}, function () {});
        }
        return run('/bin/sh', ['-c', script]).then(function (generated) {
            if (!generated.ok) throw failure('key-generation-failed');
            return Promise.all([
                run('/bin/cat', [privatePath]),
                run('/bin/cat', [publicPath])
            ]);
        }).then(function (results) {
            var privateKeyPem = String(results[0].output || '');
            var publicKeyPem = String(results[1].output || '');
            if (!results[0].ok || !results[1].ok
                || !/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(privateKeyPem)
                || !/^-----BEGIN PUBLIC KEY-----/.test(publicKeyPem)) {
                throw failure('key-generation-failed');
            }
            return {privateKeyPem: privateKeyPem, publicKeyPem: publicKeyPem};
        }).then(function (keys) {
            return cleanup().then(function () { return keys; });
        }, function (error) {
            return cleanup().then(function () { throw error; });
        });
    });
}

module.exports = {
    checkTarget: checkTarget,
    detectRuntime: detectRuntime,
    selectRuntime: selectRuntime,
    effectiveCapabilities: effectiveCapabilities,
    runtimeFromActiveLink: runtimeFromActiveLink,
    createSigningKeyPair: createSigningKeyPair
};
