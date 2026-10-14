import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {loadTypeScript} from '../scripts/helpers/load-typescript.mjs';
const {ResendEmailAdapter}=loadTypeScript('src/modules/identity/internal/auth/email/providers/resend.server.ts');
const message={kind:'email_otp',to:'synthetic@example.test',subject:'Verification',html:'<p>Synthetic test</p>',text:'Synthetic test',idempotencyKey:'synthetic/idempotent'};

test('email adapter local override preserves HTTP contract and rejects unsafe environments/origins',async()=>{
 const keys=['ELEMARKET_ENV','RESEND_BASE_URL','RESEND_API_KEY','RESEND_FROM_EMAIL'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 let received;
 const server=http.createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{received={path:request.url,headers:request.headers,body:JSON.parse(body)};response.setHeader('content-type','application/json');response.end(JSON.stringify({id:'synthetic-message'}));});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  Object.assign(process.env,{ELEMARKET_ENV:'staging',RESEND_BASE_URL:`http://127.0.0.1:${server.address().port}`,RESEND_API_KEY:'synthetic-test-key',RESEND_FROM_EMAIL:'audit@example.test'});
  const adapter=new ResendEmailAdapter();
  const sent=await adapter.send(message);
  assert.equal(sent.accepted,true);assert.equal(sent.providerId,'synthetic-message');
  assert.equal(received.path,'/emails');assert.deepEqual(received.body.to,[message.to]);
  assert.equal(received.headers['idempotency-key'],message.idempotencyKey);
  process.env.ELEMARKET_ENV='production';
  await assert.rejects(adapter.send(message),/non-production/);
  process.env.ELEMARKET_ENV='staging';
  for(const url of ['https://attacker.invalid','http://localhost:4000','http://127.0.0.1:4000/path','http://user@127.0.0.1:4000','http://127.0.0.1:4000?x=1']) {
   process.env.RESEND_BASE_URL=url;await assert.rejects(adapter.send(message),/loopback HTTP origin/);
  }
 }finally{await new Promise(resolve=>server.close(resolve));for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});
