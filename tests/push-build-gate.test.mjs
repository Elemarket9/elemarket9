import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('push is optional in beta, required for marketplace and rejects mismatched configuration', () => {
 const base={...process.env,ELEMARKET_ENV:'staging',ELEMARKET_LAUNCH_PROFILE:'developer_beta',ELEMARKET_PUSH_PROVIDER:'',VITE_ELEMARKET_PUSH_PROVIDER:''};
 const check=env=>spawnSync(process.execPath,['scripts/validate-push-client-env.mjs'],{env,encoding:'utf8'});
 assert.equal(check(base).status,0);
 assert.equal(check({...base,ELEMARKET_LAUNCH_PROFILE:'marketplace'}).status,1);
 assert.equal(check({...base,VITE_ELEMARKET_PUSH_PROVIDER:'fcm'}).status,1);
 assert.equal(check({...base,ELEMARKET_PUSH_PROVIDER:'fcm'}).status,1);
});
