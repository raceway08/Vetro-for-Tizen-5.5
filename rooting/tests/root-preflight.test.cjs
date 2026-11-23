'use strict';
const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const preflight = require('../service/root-preflight.js');

const caps = [
    '/usr/bin/dotnet = cap_setgid,cap_sys_admin+ep',
    '/usr/bin/dotnet-launcher = cap_setgid,cap_setuid,cap_setpcap,cap_sys_chroot,cap_sys_ptrace,cap_sys_admin,cap_mac_override,cap_mac_admin+eip',
    '/usr/sbin/sdbd-tarlauncher = cap_setuid,cap_setgid+ep'
].join('\n') + '\n';
const listing = version => ({ok: true, output: 'Microsoft.NETCore.App ' + version + ' [/usr/share/dotnet/shared]\n'});
const samsung = {ok: false, code: 255, output: 'Unknown option --list-runtimes.\n'};

function files(version, options) {
    const opts = options || {};
    return {
        existsSync: file => {
            if (file === '/usr/bin/dotnet') return opts.dotnet !== false;
            if (file === '/usr/bin/dotnet-launcher') return opts.launcher !== false;
            return true;
        },
        realpathSync: () => '/opt/runtime/' + version,
        accessSync: () => {}
    };
}

function probe(overrides, fileSystem) {
    const responses = Object.assign({
        dotnet: listing('6.0.2'),
        getcap: {ok: true, output: caps},
        tar: {ok: true, output: '--to-command=COMMAND'}
    }, overrides || {});
    return preflight.checkTarget({
        fs: fileSystem || files('6.0.2'),
        run: (file, args) => {
            const key = path.basename(file);
            return Promise.resolve(responses[key] || {ok: false, code: 127, output: 'not found'});
        }
    });
}

(async function () {
    assert.equal(preflight.detectRuntime(listing('3.0.0')), '3.0');
    assert.equal(preflight.detectRuntime(listing('3.1.3')), '3.1');
    assert.equal(preflight.detectRuntime(listing('8.0.1')), '6.0');
    assert.equal(preflight.detectRuntime({ok: true, output: listing('3.1.3').output + listing('6.0.2').output}), '6.0');
    for (const version of ['2.1.4', '5.0.1']) {
        assert.throws(() => preflight.detectRuntime(listing(version)), {code: 'runtime-unsupported'});
    }

    assert.equal(preflight.detectRuntime(samsung, files('3.0.0')), '3.0');
    assert.equal(preflight.detectRuntime(samsung, files('3.1.3')), '3.1');
    assert.equal(preflight.detectRuntime(samsung, files('6.0.1')), '6.0');
    assert.throws(() => preflight.detectRuntime(samsung, files('not-a-version')), {code: 'runtime-probe-failed'});
    assert.throws(() => preflight.detectRuntime(samsung, {
        realpathSync: files('3.1.3').realpathSync,
        accessSync: () => { throw Error('unreadable CLR'); }
    }), {code: 'runtime-probe-failed'});

    assert.deepEqual(await probe(), {
        runtime: '6.0', hostFile: '/usr/bin/dotnet',
        hostCommand: '/usr/bin/dotnet', source: 'detected'
    });
    assert.deepEqual(await probe({dotnet: listing('3.1.3')}), {
        runtime: '3.1', hostFile: '/usr/bin/dotnet',
        hostCommand: '/usr/bin/dotnet', source: 'detected'
    });
    assert.deepEqual(await probe({getcap: {ok: true, output: caps}}, files('3.0.0', {dotnet: false})), {
        runtime: '3.0', hostFile: '/usr/bin/dotnet-launcher',
        hostCommand: '/usr/bin/dotnet-launcher --standalone', source: 'detected'
    });
    await assert.rejects(probe({getcap: {ok: false}}), {code: 'capabilities-probe-failed'});
    await assert.rejects(probe({getcap: {ok: true, output: caps.replace('cap_sys_admin+ep', 'cap_sys_admin+p')}}), {code: 'dotnet-capabilities-missing'});
    await assert.rejects(probe({getcap: {ok: true, output: caps.split('\n')[0]}}), {code: 'launcher-capabilities-missing'});
    await assert.rejects(probe({tar: {ok: true, output: 'other options'}}), {code: 'tar-unsupported'});
    await assert.rejects(probe({tar: {ok: false}}), {code: 'tar-probe-failed'});
    await assert.rejects(probe({}, files('3.0.0', {dotnet: false, launcher: false})), {code: 'tizen55-launcher-missing'});

    const calls = [];
    const keyPair = await preflight.createSigningKeyPair((file, args) => {
        calls.push({file, args});
        if (file === '/bin/sh' && args[1] === 'command -v openssl') {
            return Promise.resolve({ok: true, output: '/usr/bin/openssl\n'});
        }
        if (file === '/bin/sh') return Promise.resolve({ok: true, output: ''});
        if (file === '/bin/cat' && args[0].endsWith('.key')) {
            return Promise.resolve({ok: true, output: '-----BEGIN RSA PRIVATE KEY-----\nTEST\n-----END RSA PRIVATE KEY-----\n'});
        }
        if (file === '/bin/cat' && args[0].endsWith('.pub')) {
            return Promise.resolve({ok: true, output: '-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n'});
        }
        return Promise.resolve({ok: true, output: ''});
    });
    assert.match(keyPair.privateKeyPem, /BEGIN RSA PRIVATE KEY/);
    assert.match(keyPair.publicKeyPem, /BEGIN PUBLIC KEY/);
    assert.ok(calls.some(call => call.file === '/bin/sh' && call.args[1].indexOf('umask 077') >= 0));
    assert.ok(calls.some(call => call.file === '/bin/rm' && call.args[0] === '-f'));

    const context = require('./provider-harness.cjs')(path.resolve(__dirname, '..')).context;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vetro-runtime-stage-'));
    const payload = path.resolve(__dirname, '..', 'payload');
    const fixtures = [];
    context.fs = fs;
    context.STAGE = tmp;
    context.cleanStage = () => [];
    const generated = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const signingKeys = {
        privateKeyPem: generated.privateKey.export({type: 'pkcs8', format: 'pem'}),
        publicKeyPem: generated.publicKey.export({type: 'spki', format: 'pem'})
    };
    try {
        const artifactSets = {
            '3.0': {directory: payload, suffix: '.tizen55', framework: '3.0'},
            '3.1': {directory: payload, suffix: '', framework: '3.1'},
            '6.0': {directory: path.join(payload, 'net6'), suffix: '', framework: '6.0'}
        };
        for (const runtime of Object.keys(artifactSets)) {
            const spec = artifactSets[runtime];
            for (const name of ['SamsungTvArchiveRoot', 'SamsungTvRootAgent']) {
                for (const suffix of ['.dll', '.deps.json', '.runtimeconfig.json']) {
                    const builtName = name + spec.suffix + suffix;
                    const file = path.join(spec.directory, builtName);
                    if (!fs.existsSync(file)) {
                        const body = suffix === '.deps.json'
                            ? JSON.stringify({runtimeTarget: {name: '.NETCoreApp,Version=v' + spec.framework}})
                            : suffix === '.runtimeconfig.json'
                                ? JSON.stringify({runtimeOptions: {framework: {version: spec.framework + '.0'}}})
                                : name + ' fixture ' + runtime;
                        fs.writeFileSync(file, body);
                        fixtures.push(file);
                    }
                }
            }
            context.prepare(12345, runtime, signingKeys);
            for (const name of ['SamsungTvArchiveRoot', 'SamsungTvRootAgent']) {
                const staged = path.join(tmp, context.pkg, name);
                const sourceBase = path.join(spec.directory, name + spec.suffix);
                assert.deepEqual(fs.readFileSync(staged + '.dll'), fs.readFileSync(sourceBase + '.dll'));
                const config = JSON.parse(fs.readFileSync(staged + '.runtimeconfig.json'));
                assert.equal(config.runtimeOptions.framework.version, spec.framework + '.0');
                assert.equal(config.runtimeOptions.rollForward, runtime === '6.0' ? 'Major' : 'LatestPatch');
                assert.equal(JSON.parse(fs.readFileSync(staged + '.deps.json')).runtimeTarget.name,
                    '.NETCoreApp,Version=v' + spec.framework);
            }
        }
    } finally {
        fixtures.forEach(file => { try { fs.unlinkSync(file); } catch (error) {} });
        fs.rmSync(tmp, {recursive: true, force: true});
    }
    console.log('PASS .NET 3.0/3.1/6 runtime detection, launcher capabilities, OpenSSL keygen and payload staging');
})().catch(error => { console.error(error); process.exitCode = 1; });
