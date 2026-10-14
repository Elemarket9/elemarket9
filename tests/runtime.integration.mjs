import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const redis=process.env.REDIS_URL;
if(!redis || new URL(redis).hostname!=='127.0.0.1') throw new Error('Explicit loopback Redis required');
const result=spawnSync(process.execPath,['tests/fixtures/redis-exit.mjs'],{encoding:'utf8',timeout:3000});
assert.equal(result.status,0,`Idle Redis must allow a process with no remaining work to exit: ${result.error?.code??result.stderr}`);
assert.match(result.stdout,/Redis ping completed/);
console.log('PASS: real Redis command completes and idle connection does not retain the process');
