'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const scriptPath = path.join(__dirname, '..', 'smb-inbox', 'tu8000-remote-pc-preflight.sh');
const source = fs.readFileSync(scriptPath, 'utf8');

assert.ok(source.indexOf('VETRO-REMOTEPC-PREFLIGHT/1') >= 0);
assert.ok(source.indexOf('/usr/apps/privileged-service/bin/mount.smb.sh') >= 0);
assert.ok(source.indexOf('/etc/profile.d/bash_prompt_custom.sh') >= 0);
assert.ok(source.indexOf('/etc/prd_info.ini') >= 0);
assert.ok(source.indexOf('^Version=') >= 0);
assert.ok(source.indexOf('/proc/partitions') >= 0);
assert.ok(source.indexOf('openssl dgst -sha256') >= 0);

// The preflight is intentionally read-only. These checks are a guard against
// accidentally turning this diagnostic into a persistence installer.
const forbidden = [
  /(^|[\s;&|])dd([\s;&|]|$)/m,
  /\bmkfs(?:\.[A-Za-z0-9_-]+)?\b/i,
  /\bflash_erase\b/i,
  /\bblockdev\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bshutdown\b/i,
  /mount\s+-o\s+remount/i,
  /\/sys\/fs\/smackfs\/load2?/i,
  /\bsed\s+-i\b/i
];
for (const pattern of forbidden) {
  assert.equal(pattern.test(source), false, 'read-only preflight contains forbidden write operation: ' + pattern);
}

const syntax = childProcess.spawnSync('sh', ['-n', scriptPath], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || 'POSIX shell syntax check failed');
console.log('PASS TU8000 preflight: shell syntax and read-only guard checks');
