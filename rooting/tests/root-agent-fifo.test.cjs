'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

const service = path.join(__dirname, '..', 'service');
const agent = fs.readFileSync(path.join(service, 'root-agent-node.js'), 'utf8');
const worker = fs.readFileSync(path.join(service, 'root-agent-worker.sh'), 'utf8');
const platform = fs.readFileSync(path.join(service, 'platform.js'), 'utf8');
const builder = fs.readFileSync(path.join(__dirname, '..', 'build.cjs'), 'utf8');

// Parse the actual target-side source on the host test runner.
new Function(agent);
assert.doesNotMatch(agent, /require\s*\(\s*['"]child_process['"]\s*\)/);
assert.doesNotMatch(agent, /\.spawn\s*\(/);
assert.match(agent, /FIFO_FLAGS\s*=\s*2050/);
assert.match(agent, /MAX_OUTPUT\s*=\s*1024\s*\*\s*1024/);
assert.match(agent, /SAMSUNG-TV-ROOT\/1/);

// The worker is invoked as shell source via sh -c by launch.sh. It must expose
// the four FIFO endpoints and return a result only after the command completes.
assert.match(worker, /exec 3<> "\$D\/commands"/);
assert.match(worker, /exec 4<> "\$D\/results"/);
assert.match(worker, /exec 5<> "\$D\/stdout"/);
assert.match(worker, /exec 6<> "\$D\/stderr"/);
assert.match(worker, /setsid \/bin\/sh -c/);
assert.match(worker, /printf 'RESULT\\t%s\\t%s\\t%s\\n'/);

assert.match(platform, /runtime === '3\.0' && process\.version === 'v4\.4\.3'/);
assert.match(platform, /agent-runtime-\$\$/);
assert.match(platform, /setsid \/bin\/sh -c "\$WORKER_SOURCE"/);
assert.match(builder, /'root-agent-node\.js','root-agent-worker\.sh'/);

console.log('PASS Node 4.4 FIFO root-agent compatibility and packaging');
