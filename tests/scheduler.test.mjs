import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import { runScheduledJob } from '../scripts/scheduler-request.mjs';
import { signedHeaders } from '../scripts/scheduler-core.mjs';
const secret=randomBytes(32).toString('hex');
const path='/api/internal/refresh-eide';

test('private scheduler preserves configured portal Host and path-bound HMAC',async()=>{
 let seen;
 const server=http.createServer((request,response)=>{seen=request;response.writeHead(200);response.end();});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  await runScheduledJob({base:`http://127.0.0.1:${server.address().port}`,path,secret,env:{ELEMARKET_PORTAL_HOST_ROUTING:'1',ELEMARKET_DOMAIN:'marketplace.example.test'}});
  assert.equal(seen.headers.host,'marketplace.example.test');
  assert.equal(seen.url,path);
  assert.equal(seen.headers['x-forwarded-for'],undefined,'Internal identity must not forge a client IP');
  const expected=signedHeaders({secret,path,timestamp:seen.headers['x-elemarket-sync-timestamp'],nonce:seen.headers['x-elemarket-sync-nonce']});
  for(const [name,value] of Object.entries(expected)) assert.equal(seen.headers[name],value);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('scheduler refuses missing portal configuration and unsigned job paths',()=>{
 assert.throws(()=>runScheduledJob({base:'http://app:8080',path,secret,env:{ELEMARKET_PORTAL_HOST_ROUTING:'1'}}),/requires ELEMARKET_DOMAIN/);
 assert.throws(()=>runScheduledJob({base:'http://app:8080',path:'/admin',secret,env:{}}),/not registered/);
});

test('scheduler rejects redirects without following or logging sensitive bodies',async()=>{
 let count=0;
 const server=http.createServer((_request,response)=>{count++;response.writeHead(302,{location:'/admin'});response.end('private response must not appear in error');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  await assert.rejects(runScheduledJob({base:`http://127.0.0.1:${server.address().port}`,path,secret,env:{}}),{message:'HTTP 302'});
  assert.equal(count,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('beta scheduler health remains valid between five-minute jobs',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const directory=await mkdtemp(join(tmpdir(),'elemarket-heartbeat-'));const file=join(directory,'heartbeat.json');
 try{
  const now=Date.now();
  await writeFile(file,JSON.stringify({checkedAt:now,jobs:0,failures:0,lastRun:{at:now-60000,jobs:1,failures:0}}));
  const result=spawnSync(process.execPath,['scripts/scheduler-health.mjs'],{env:{...process.env,ELEMARKET_SCHEDULER_HEARTBEAT:file},encoding:'utf8'});
  assert.equal(result.status,0,'An idle minute after a successful scheduled job is healthy');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('idle heartbeats preserve failures, reject stale work and require a first completed run',async()=>{
 const {nextHeartbeat,heartbeatHealthy}=await import('../scripts/scheduler-heartbeat.mjs');
 const now=1000000;
 assert.equal(heartbeatHealthy(nextHeartbeat(null,{now,jobs:0,failures:0}),now),false);
 const success=nextHeartbeat(null,{now,jobs:1,failures:0});
 assert.equal(heartbeatHealthy(success,now),true);
 const idle=nextHeartbeat(success,{now:now+60000,jobs:0,failures:0});
 assert.equal(heartbeatHealthy(idle,now+60000),true);
 assert.equal(heartbeatHealthy(idle,now+240000),false,'stale scheduler loop');
 assert.equal(heartbeatHealthy(nextHeartbeat(idle,{now:now+380000,jobs:0,failures:0}),now+380000),false,'fresh loop cannot hide overdue job');
 const failed=nextHeartbeat(success,{now:now+300000,jobs:1,failures:1});
 assert.equal(heartbeatHealthy(nextHeartbeat(failed,{now:now+360000,jobs:0,failures:0}),now+360000),false);
 assert.equal(heartbeatHealthy(nextHeartbeat(failed,{now:now+600000,jobs:1,failures:0}),now+600000),true);
});
