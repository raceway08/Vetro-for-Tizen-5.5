'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

const platformPath = path.join(__dirname, '..', 'service', 'platform.js');
const agentPath = path.join(__dirname, '..', 'service', 'root-agent-node.js');
const workerPath = path.join(__dirname, '..', 'service', 'root-agent-worker.js');
const platform = fs.readFileSync(platformPath, 'utf8');
const agent = fs.readFileSync(agentPath, 'utf8');
const worker = require(workerPath);

// Parse all target-side JavaScript with the host parser. The existing Node 4
// syntax suite separately constrains syntax and built-ins for the TV runtime.
new Function(platform);
new Function(agent);

assert.match(platform, /function createManualRootBootstrap\(agentPort\)/);
assert.match(platform, /process\.version !== 'v4\.4\.3'/);
assert.match(platform, /System::Privileged/);
assert.match(platform, /crypto\.createHash\('sha256'\)/);
assert.match(platform, /RUN_ID=\$\(\/bin\/cat \/proc\/sys\/kernel\/random\/uuid/);
assert.match(platform, /\/usr\/bin\/setsid \/bin\/sh -c "\$WORKER_SOURCE"/);
assert.match(platform, /\/usr\/bin\/node -e "\$NODE_SOURCE" -- --vetro-eval/);
assert.match(platform, /consumeManualRootToken\(\)/);
assert.match(platform, /refreshManualRootToken\(\)/);
assert.match(platform, /bootstrapPath: startPath/);
assert.match(agent, /keepBootstrapToken = process\.argv\[1\] === '--vetro-eval'/);
assert.match(agent, /if \(!keepBootstrapToken\) fs\.unlinkSync\(tokenPath\)/);
assert.match(worker, /exec 3<> "\$D\/commands"/);
assert.match(worker, /exec 4<> "\$D\/results"/);
assert.match(worker, /exec 5<> "\$D\/stdout"/);
assert.match(worker, /exec 6<> "\$D\/stderr"/);
assert.doesNotMatch(platform, /work-\$["']/);
assert.doesNotMatch(platform, /setsid \/bin\/sh \"\$BASE\/start\.sh/);

console.log('PASS temporary Tizen 5.5 manual root-agent bootstrap contract');
