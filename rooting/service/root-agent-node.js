'use strict';

// Tizen 5.5 / Node 4.4 root agent. Command execution is delegated to a
// signed-archive-launched shell worker through four FIFOs. This deliberately
// avoids child_process: the TV's Node 4.4.3 / libuv 1.8.0 aborts in uv_close
// for even a trivial child_process.spawn() call.
var fs = require('fs');
var net = require('net');
var crypto = require('crypto');

var tokenPath = process.argv[2];
var port = Number(process.argv[3]);
var statusPath = process.argv[4];
var logPath = process.argv[5];
var workDir = process.argv[6];

var MAX_FRAME = 8 * 1024 * 1024;
var MAX_COMMAND = 64 * 1024;
var MAX_OUTPUT = 1024 * 1024;
var FIFO_FLAGS = 2050; // Linux O_RDWR (2) | O_NONBLOCK (2048)

var secret = null;
var nonce = null;
var capabilities = null;
var smack = null;
var socket = null;
var input = '';
var authenticated = false;
var workerReady = false;
var closing = false;
var finalized = false;
var lastSequence = 0;
var active = null;
var resultInput = '';
var commandFd = -1;
var resultFd = -1;
var stdoutFd = -1;
var stderrFd = -1;
var pollTimer = null;
var startupTimer = null;
var shutdownTimer = null;

function log(message) {
    try {
        fs.appendFileSync(logPath,
            new Date().toISOString() + ' ' + message + '\n');
    } catch (e) {}
}

function status(message) {
    try {
        fs.writeFileSync(statusPath,
            new Date().toISOString() + ' ' + message + '\n');
    } catch (e) {}
}

function capEff() {
    var lines = fs.readFileSync('/proc/self/status', 'utf8').split('\n');
    var i;
    for (i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('CapEff:') === 0) {
            return lines[i].substring(7).trim();
        }
    }
    throw new Error('CapEff missing');
}

function mac(payload) {
    return crypto.createHmac('sha256', secret)
        .update(nonce)
        .update(new Buffer([0]))
        .update(payload, 'utf8')
        .digest('hex');
}

function equalHex(a, b) {
    if (a.length !== b.length) return false;
    var difference = 0;
    var i;
    for (i = 0; i < a.length; i++) {
        difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return difference === 0;
}

function send(payload) {
    if (!socket || socket.destroyed) return false;
    socket.write(payload + '\t' + mac(payload) + '\n');
    return true;
}

function closeFd(fd) {
    if (fd < 0) return;
    try { fs.closeSync(fd); } catch (e) {}
}

function finalize() {
    if (finalized) return;
    finalized = true;
    if (pollTimer) clearInterval(pollTimer);
    if (startupTimer) clearTimeout(startupTimer);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    closeFd(commandFd);
    closeFd(resultFd);
    closeFd(stdoutFd);
    closeFd(stderrFd);
    commandFd = resultFd = stdoutFd = stderrFd = -1;
    status('stopped');
    log('agent stopped');
    process.exitCode = 0;
}

function beginShutdown(reason) {
    if (closing || finalized) return;
    closing = true;
    status(reason || 'disconnected');
    log(reason || 'disconnected');
    if (startupTimer) clearTimeout(startupTimer);
    if (socket && !socket.destroyed) {
        try { socket.destroy(); } catch (e) {}
    }
    try {
        if (commandFd >= 0) fs.writeSync(commandFd, 'QUIT\n');
    } catch (e) {
        log('could not queue worker shutdown: ' + (e.message || e));
    }
    // A current command has its own bounded timeout (max 120 s). Keep draining
    // its output until the worker reports STOPPED rather than closing its FIFOs.
    shutdownTimer = setTimeout(function () {
        log('worker shutdown grace period expired');
        finalize();
    }, 130000);
}

function appendCapture(target, chunk) {
    var remaining = MAX_OUTPUT - target.size;
    if (remaining > 0) {
        var part = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
        target.parts.push(part);
        target.size += part.length;
    }
    if (chunk.length > remaining) target.truncated = true;
}

function drainCapture(fd, target) {
    var buffer = new Buffer(8192);
    var loops = 0;
    while (loops++ < 16) {
        var count;
        try {
            count = fs.readSync(fd, buffer, 0, buffer.length, null);
        } catch (e) {
            if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') return;
            throw e;
        }
        if (!count) return;
        if (target) appendCapture(target, buffer.slice(0, count));
    }
}

function sendCommandResult(sequence, code, timedOut) {
    if (!active || active.sequence !== sequence) {
        throw new Error('worker result did not match active command');
    }

    // The worker writes RESULT only after the command's output descriptors are
    // closed. Drain both FIFOs again so bytes cannot trail the RESULT frame.
    drainCapture(stdoutFd, active.stdout);
    drainCapture(stderrFd, active.stderr);

    var stdout = Buffer.concat(active.stdout.parts);
    var stderr = Buffer.concat(active.stderr.parts);

    if (active.stdout.truncated || active.stderr.truncated) {
        var streams = active.stdout.truncated && active.stderr.truncated
            ? 'stdout and stderr'
            : active.stdout.truncated ? 'stdout' : 'stderr';
        stderr = Buffer.concat([stderr, new Buffer(
            '\n[samsung-tv-root: ' + streams +
            ' exceeded the 1 MiB capture limit]\n')]);
    }

    active = null;
    if (!closing && authenticated) {
        send('RESULT\t' + sequence + '\t' + code +
            '\t' + (timedOut ? '1' : '0') +
            '\t' + stdout.toString('base64') +
            '\t' + stderr.toString('base64'));
    }
}

function handleWorkerLine(line) {
    if (line === 'READY') {
        if (workerReady) return;
        workerReady = true;
        if (startupTimer) clearTimeout(startupTimer);
        log('FIFO command worker ready');
        connectAgent();
        return;
    }

    if (line === 'STOPPED') {
        log('FIFO command worker stopped');
        finalize();
        return;
    }

    var fields = line.split('\t');
    if (fields[0] === 'RESULT' && fields.length === 4) {
        if (!/^[1-9][0-9]*$/.test(fields[1]) ||
            !/^-?[0-9]+$/.test(fields[2]) ||
            !/^[01]$/.test(fields[3])) {
            throw new Error('invalid worker result frame');
        }
        sendCommandResult(fields[1], Number(fields[2]), fields[3] === '1');
        return;
    }

    if (fields[0] === 'ERROR' && fields.length >= 2) {
        if (!active || active.sequence !== fields[1]) {
            throw new Error('worker error did not match active command');
        }
        log('worker reported command error for sequence ' + fields[1]);
        sendCommandResult(fields[1], 127, false);
        return;
    }

    throw new Error('unexpected worker message');
}

function drainResults() {
    var buffer = new Buffer(4096);
    var loops = 0;
    while (loops++ < 16) {
        var count;
        try {
            count = fs.readSync(resultFd, buffer, 0, buffer.length, null);
        } catch (e) {
            if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') return;
            throw e;
        }
        if (!count) return;
        resultInput += buffer.slice(0, count).toString('utf8');
        if (resultInput.length > 65536) throw new Error('worker response buffer too large');

        var index;
        while ((index = resultInput.indexOf('\n')) >= 0) {
            var line = resultInput.substring(0, index);
            resultInput = resultInput.substring(index + 1);
            if (line) handleWorkerLine(line);
        }
    }
}

function poll() {
    if (finalized) return;
    try {
        if (active) {
            drainCapture(stdoutFd, active.stdout);
            drainCapture(stderrFd, active.stderr);
        } else {
            drainCapture(stdoutFd, null);
            drainCapture(stderrFd, null);
        }
        drainResults();
    } catch (e) {
        log('FIFO polling failed: ' + (e.message || e));
        beginShutdown('failed fifo-io');
    }
}

function connectAgent() {
    if (closing || socket || !workerReady) return;
    socket = net.connect(port, '127.0.0.1');
    socket.setNoDelay(true);

    socket.on('connect', function () {
        log('connected to Vetro loopback listener');
    });

    socket.on('data', function (chunk) {
        input += chunk.toString('utf8');
        if (input.length > MAX_FRAME && input.indexOf('\n') < 0) {
            return beginShutdown('failed oversized server frame');
        }

        var index;
        while ((index = input.indexOf('\n')) >= 0) {
            var line = input.substring(0, index);
            input = input.substring(index + 1);
            if (!line) continue;

            if (!authenticated) {
                var hello = line.split('\t');
                if (hello.length !== 2 ||
                    hello[0] !== 'SAMSUNG-TV-ROOT/1' ||
                    !/^[a-f0-9]{64}$/.test(hello[1])) {
                    return beginShutdown('failed invalid Vetro challenge');
                }

                nonce = new Buffer(hello[1], 'hex');
                var auth = [
                    'AUTH',
                    process.pid,
                    process.getuid(),
                    process.geteuid(),
                    process.getgid(),
                    process.getegid(),
                    capabilities,
                    new Buffer(smack, 'utf8').toString('base64')
                ].join('\t');

                send(auth);
                authenticated = true;
                status('auth-sent pid=' + process.pid + ' uid=0 gid=0');
                log('AUTH sent; CapEff=' + capabilities + '; security context=' + smack);
            } else {
                try {
                    handleServerFrame(line);
                } catch (error) {
                    log('server frame error: ' + (error.message || error));
                    beginShutdown('failed invalid server frame');
                    return;
                }
            }
        }
    });

    socket.on('error', function (error) {
        log('socket error: ' + (error.message || error));
        beginShutdown('disconnected socket-error');
    });

    socket.on('close', function () {
        if (!closing) beginShutdown('disconnected');
    });
}

function handleServerFrame(line) {
    var separator = line.lastIndexOf('\t');
    if (separator < 1) throw new Error('invalid authenticated server frame');

    var payload = line.substring(0, separator);
    var observed = line.substring(separator + 1);
    var expected = mac(payload);

    if (!/^[a-f0-9]{64}$/.test(observed) || !equalHex(observed, expected)) {
        throw new Error('server authentication failed');
    }

    var fields = payload.split('\t');
    if (fields.length < 2 || !/^[1-9][0-9]*$/.test(fields[1])) {
        throw new Error('invalid server sequence');
    }

    var sequence = Number(fields[1]);
    if (sequence <= lastSequence) throw new Error('non-increasing server sequence');
    lastSequence = sequence;

    if (fields[0] === 'PING' && fields.length === 2) {
        send('PONG\t' + fields[1] + '\t0\t0\t0\t0');
        return;
    }

    if (fields[0] === 'SHUTDOWN' && fields.length === 2) {
        send('BYE\t' + fields[1]);
        if (socket && !socket.destroyed) socket.end();
        return;
    }

    if (fields[0] !== 'EXEC' || fields.length !== 4) {
        throw new Error('unsupported server command');
    }
    if (active) throw new Error('overlapping EXEC');

    var timeout = Number(fields[2]);
    if (!/^[0-9]+$/.test(fields[2]) || timeout < 100 || timeout > 120000) {
        throw new Error('invalid command timeout');
    }

    var commandBuffer = new Buffer(fields[3], 'base64');
    if (!commandBuffer.length || commandBuffer.length > MAX_COMMAND) {
        throw new Error('invalid command size');
    }
    var command = commandBuffer.toString('utf8');
    if (command.indexOf('\u0000') !== -1) throw new Error('command contains NUL');

    var commandPath = workDir + '/cmd-' + fields[1];
    fs.writeFileSync(commandPath, commandBuffer, {mode: 384});
    active = {
        sequence: fields[1],
        stdout: {parts: [], size: 0, truncated: false},
        stderr: {parts: [], size: 0, truncated: false}
    };

    // The FIFO carries only a small metadata line. The command itself is
    // written to a mode-0600 file, avoiding PIPE_BUF limits on large commands.
    fs.writeSync(commandFd, 'EXEC\t' + fields[1] + '\t' + timeout + '\n');
}

function begin() {
    if (process.getuid() !== 0 || process.geteuid() !== 0 ||
        process.getgid() !== 0 || process.getegid() !== 0) {
        throw new Error('agent requires root identity');
    }
    if (!tokenPath || !statusPath || !logPath || !workDir ||
        !port || port < 1 || port > 65535) {
        throw new Error('invalid agent arguments');
    }

    status('starting');
    var encodedSecret = fs.readFileSync(tokenPath, 'utf8').trim();
    secret = new Buffer(encodedSecret, 'base64');
    fs.unlinkSync(tokenPath);
    if (secret.length < 32) throw new Error('invalid authentication token');

    smack = fs.readFileSync('/proc/self/attr/current', 'utf8').trim();
    capabilities = capEff();

    commandFd = fs.openSync(workDir + '/commands', FIFO_FLAGS);
    resultFd = fs.openSync(workDir + '/results', FIFO_FLAGS);
    stdoutFd = fs.openSync(workDir + '/stdout', FIFO_FLAGS);
    stderrFd = fs.openSync(workDir + '/stderr', FIFO_FLAGS);

    pollTimer = setInterval(poll, 25);
    startupTimer = setTimeout(function () {
        if (!workerReady) beginShutdown('failed worker-start-timeout');
    }, 10000);
    status('waiting-worker');
    log('opened four FIFO descriptors; waiting for worker');
}

process.on('SIGTERM', function () { beginShutdown('received SIGTERM'); });
process.on('SIGHUP', function () { beginShutdown('received SIGHUP'); });
process.on('SIGINT', function () { beginShutdown('received SIGINT'); });
process.on('exit', function (code) { log('process exit code=' + code); });

try {
    begin();
} catch (error) {
    log('ERROR ' + (error.stack || error));
    status('failed ' + (error.message || error));
    beginShutdown('failed startup');
}
