'use strict';
// Node 4.4 lacks crypto.generateKeyPairSync/KeyObject export. The Tizen 5.5
// adapter instead asks the TV's OpenSSL for an ephemeral key pair and signs
// the archive with the long-standing crypto.createSign API.
const assert = require('assert').strict;
const crypto = require('crypto');
const preflight = require('../service/root-preflight.js');
const keys = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
const privatePem = keys.privateKey.export({type: 'pkcs8', format: 'pem'});
const publicPem = keys.publicKey.export({type: 'spki', format: 'pem'});
const sample = Buffer.from('Tizen 5.5 signing compatibility');
const signer = crypto.createSign('RSA-SHA256');
signer.update(sample);
const signature = signer.sign(privatePem);
const verifier = crypto.createVerify('RSA-SHA256');
verifier.update(sample);
assert.equal(verifier.verify(publicPem, signature), true);

let calls = 0;
preflight.createSigningKeyPair((file, args) => {
    calls++;
    if (file === '/bin/sh' && args[1] === 'command -v openssl') {
        return Promise.resolve({ok: true, output: '/usr/bin/openssl\n'});
    }
    if (file === '/bin/sh') return Promise.resolve({ok: true, output: ''});
    if (file === '/bin/cat' && args[0].endsWith('.key')) {
        return Promise.resolve({ok: true, output: privatePem});
    }
    if (file === '/bin/cat' && args[0].endsWith('.pub')) {
        return Promise.resolve({ok: true, output: publicPem});
    }
    return Promise.resolve({ok: true, output: ''});
}).then(function (pair) {
    assert.match(pair.privateKeyPem, /BEGIN .*PRIVATE KEY/);
    assert.match(pair.publicKeyPem, /BEGIN PUBLIC KEY/);
    assert.ok(calls >= 5);
    console.log('PASS Node 4 signing path: no generateKeyPairSync required; createSign verifies');
}).catch(function (error) {
    console.error(error);
    process.exitCode = 1;
});
