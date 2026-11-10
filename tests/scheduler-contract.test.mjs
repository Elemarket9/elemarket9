import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { JOBS, signedHeaders, dueJobs } from '../scripts/scheduler-core.mjs';
import { nextHeartbeat, heartbeatHealthy } from '../scripts/scheduler-heartbeat.mjs';
test('every scheduled job has unique approved internal path and cadence', () => {
  assert.ok(JOBS.length > 0);
  assert.equal(new Set(JOBS.map(j=>j.path)).size,JOBS.length);
  for(const j of JOBS){assert.match(j.path,/^\/api\/internal\/[a-z-]+$/);assert.ok(Number.isSafeInteger(j.everyMinutes)&&j.everyMinutes>0);}
});
test('scheduler signatures bind timestamp nonce method path and empty-body hash', () => {
  const secret='x'.repeat(40), path=JOBS[0].path,timestamp=1730000000000,nonce='a'.repeat(48);
  const h=signedHeaders({secret,path,timestamp,nonce});
  const hash=createHash('sha256').update('').digest('hex');
  assert.equal(h['x-elemarket-body-sha256'],hash);
  assert.equal(h['x-elemarket-sync-signature'],createHmac('sha256',secret).update(`${timestamp}.${nonce}.GET.${path}.${hash}`).digest('hex'));
  assert.throws(()=>signedHeaders({secret,path:'/api/admin/delete'}),/not registered/);
  assert.throws(()=>signedHeaders({secret:'too-short',path}),/at least 32/);
});
test('due jobs use their configured interval',()=>{
  assert.equal(dueJobs(10).length,JOBS.length);
  assert.ok(dueJobs(11).every(j=>j.everyMinutes===1));
});
test('failed worker status stays unhealthy across idle ticks',()=>{
  const at=1730000000000;
  const failed=nextHeartbeat(null,{now:at,jobs:2,failures:1});
  const idle=nextHeartbeat(failed,{now:at+60000,jobs:0,failures:0});
  assert.equal(heartbeatHealthy(idle,at+60000),false);
  const ok=nextHeartbeat(idle,{now:at+120000,jobs:2,failures:0});
  assert.equal(heartbeatHealthy(ok,at+120000),true);
  assert.equal(heartbeatHealthy(ok,at+400000),false);
});
