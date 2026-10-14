import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createPaymentFixture } from '../scripts/helpers/payment-fixture.mjs';

const databaseUrl=process.env.ELEMARKET_INTEGRATION_DATABASE_URL;
if (process.env.RUN_DB_INTEGRATION !== '1' || !databaseUrl) throw new Error('Set RUN_DB_INTEGRATION=1 and ELEMARKET_INTEGRATION_DATABASE_URL to a disposable migrated PostgreSQL database');
const parsed=new URL(databaseUrl);
if (!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) throw new Error('Integration tests require a local database ending in _test');
const pool=new pg.Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:3000,options:'-c statement_timeout=10000'});
test.after(()=>pool.end());

test('PostgreSQL migration ledger matches every packaged checksum',async()=>{
 const manifest=JSON.parse(readFileSync('migrations.sha256.json','utf8'));
 const rows=(await pool.query('select name,checksum from _migrations order by name')).rows;
 assert.deepEqual(Object.fromEntries(rows.map(r=>[r.name,r.checksum])),manifest);
});

async function fixture(){
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  const ids=await createPaymentFixture((sql,params)=>client.query(sql,params));
  await client.query('COMMIT'); return ids;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function checkout(ids,key,options={}) {
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query("select set_config('app.user_id',$1,true)",[options.actor??ids.user]);
  const result=await client.query('select create_pending_order($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8) as result',[
   ids.user,key,ids.fingerprint,JSON.stringify([{productId:ids.product,variantId:ids.variant,quantity:1}]),
   JSON.stringify([{merchantId:ids.merchant,quoteId:options.quote??ids.quote}]),'1 Test Street','mobile_money',null]);
  await client.query('COMMIT');return result.rows[0].result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

test('concurrent identical checkout requests reserve stock exactly once',async()=>{
 const ids=await fixture(); const key=`checkout_${randomUUID()}`;
 const results=await Promise.all(Array.from({length:6},()=>checkout(ids,key)));
 assert.equal(new Set(results.map(r=>r.groupId)).size,1);
 assert.equal(results.filter(r=>!r.replay).length,1);
 assert.equal((await pool.query('select stock from product_variants where id=$1',[ids.variant])).rows[0].stock,0);
 const group=results[0].groupId;
 assert.equal((await pool.query('select count(*)::int as n from orders where group_id=$1',[group])).rows[0].n,1);
 assert.equal((await pool.query('select count(*)::int as n from payments where order_id in(select id from orders where group_id=$1) and status=\'succeeded\'',[group])).rows[0].n,0);
});

test('checkout rejects identity substitution and rolls back a missing quote',async()=>{
 const ids=await fixture();
 await assert.rejects(checkout(ids,`identity_${randomUUID()}`,{actor:'another-user'}),/unauthorized/);
 const key=`failed_${randomUUID()}`;
 await assert.rejects(checkout(ids,key,{quote:'missing-quote'}),/delivery quote missing/);
 assert.equal((await pool.query('select stock from product_variants where id=$1',[ids.variant])).rows[0].stock,1);
 assert.equal((await pool.query('select count(*)::int as n from order_idempotency where idem=$1',[key])).rows[0].n,0);
});

test('competing checkouts cannot oversell the last unit',async()=>{
 const ids=await fixture();
 const result=await Promise.allSettled([checkout(ids,`race_a_${randomUUID()}`),checkout(ids,`race_b_${randomUUID()}`)]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
 assert.match(result.find(r=>r.status==='rejected').reason.message,/insufficient variant stock/);
 assert.equal((await pool.query('select stock from product_variants where id=$1',[ids.variant])).rows[0].stock,0);
});

test('migration gate refuses an applied row with no historical checksum',async()=>{
 const {spawnSync}=await import('node:child_process');
 const {name,checksum}=(await pool.query('select name,checksum from _migrations order by name limit 1')).rows[0];
 await pool.query('update _migrations set checksum=null where name=$1',[name]);
 try {
  const run=spawnSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DATABASE_URL:databaseUrl},encoding:'utf8'});
  assert.equal(run.status,1,'Unverifiable history must not be silently stamped with current source checksums');
  assert.match(run.stderr,/missing.*checksum|checksum.*missing/i);
  assert.equal((await pool.query('select checksum from _migrations where name=$1',[name])).rows[0].checksum,null);
 }finally{
  // Restore the exact original value in this disposable test database only.
  await pool.query('update _migrations set checksum=$1 where name=$2',[checksum,name]);
 }
});

// Exercise the real OTP module against PostgreSQL. Only email delivery and the
// HTTP rate-limit boundary are substituted; SQL and transaction rollback run.
async function emailOtpFixture() {
 const {createHmac}=await import('node:crypto');
 const {loadTypeScript}=await import('../scripts/helpers/load-typescript.mjs');
 const userId=`audit_otp_${randomUUID()}`;
 const challengeId=`otp_${randomUUID().replaceAll('-','')}`;
 const email=`${userId}@example.test`;
 const code='314159';
 const secret=process.env.BETTER_AUTH_SECRET;
 assert.ok(secret,'Integration environment must supply an isolated auth secret');
 await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,false,now(),now())',[userId,email]);
 await pool.query(`insert into otp_challenges (id,user_id,destination,purpose,provider,status,expires_at,attempts,max_attempts,cooldown_until,code_hash)
 values ($1,$2,$3,'signup','resend','pending',now()+interval '5 minutes',0,5,now(),$4)`,[challengeId,userId,email,createHmac('sha256',secret).update(`${challengeId}:${code}`).digest('hex')]);
 let failUserWrite=false;
 const query=async(client,text,params)=>{
  if(failUserWrite && /update "user"/i.test(text)) throw new Error('Injected account write failure');
  return (await client.query(text,params)).rows;
 };
 const otp=loadTypeScript('src/modules/identity/internal/auth/email/email-otp.server.ts',{
  '@/lib/db':{
   getSql:async()=>({query:(text,params)=>query(pool,text,params)}),
   withTransaction:async(work)=>{
    const client=await pool.connect();
    try {await client.query('BEGIN');const result=await work({query:(text,params)=>query(client,text,params)});await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   },
  },
  '@/lib/security/rate-limit.server':{enforceRateLimit:async()=>{}},
  './registry.server':{getEmailAdapter:()=>({key:'resend'})},
 });
 return {userId,challengeId,email,verify:()=>otp.verifyEmailOtp({challengeId,code,expectedPurpose:'signup'}),
  failWrite:(value)=>{failUserWrite=value;},
  state:async()=>({challenge:(await pool.query('select status,attempts from otp_challenges where id=$1',[challengeId])).rows[0],user:(await pool.query('select "emailVerified" from "user" where id=$1',[userId])).rows[0]}),
  cleanup:async()=>{await pool.query('delete from otp_challenges where id=$1',[challengeId]);await pool.query('delete from profiles where user_id=$1',[userId]);await pool.query('delete from "user" where id=$1',[userId]);},
 };
}

test('email OTP consumption rolls back when account verification fails',async()=>{
 const fixture=await emailOtpFixture();
 try {
  fixture.failWrite(true);
  await assert.rejects(fixture.verify(),/Injected account write failure/);
  assert.deepEqual(await fixture.state(),{challenge:{status:'pending',attempts:1},user:{emailVerified:false}});
  fixture.failWrite(false);
  assert.equal((await fixture.verify()).verified,true);
  assert.equal((await fixture.state()).user.emailVerified,true);
 }finally{await fixture.cleanup();}
});

test('email OTP cannot verify a changed email or falsely report success',async()=>{
 const fixture=await emailOtpFixture();
 try {
  await pool.query('update "user" set email=$2 where id=$1',[fixture.userId,`changed_${fixture.email}`]);
  await assert.rejects(fixture.verify(),/account.*changed|account.*unavailable/i);
  assert.equal((await fixture.state()).challenge.status,'pending');
  assert.equal((await fixture.state()).user.emailVerified,false);
 }finally{await fixture.cleanup();}
});

test('concurrent email OTP verification succeeds once and rejects replay',async()=>{
 const fixture=await emailOtpFixture();
 try {
  const results=await Promise.allSettled(Array.from({length:6},()=>fixture.verify()));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await fixture.state()).challenge.status,'verified');
  assert.equal((await fixture.state()).user.emailVerified,true);
  await assert.rejects(fixture.verify(),/invalid|consumed/);
 }finally{await fixture.cleanup();}
});

async function phoneOtpFixture() {
 const {loadTypeScript,serverFunctionStub}=await import('../scripts/helpers/load-typescript.mjs');
 const userId=`audit_phone_${randomUUID()}`;
 const challengeId=`otp_${randomUUID().replaceAll('-','')}`;
 const number='+233500000001';
 await pool.query('insert into "user"(id,name,email,"emailVerified") values($1,$1,$2,true)',[userId,`${userId}@example.test`]);
 // Synthetic fixture is deleted in finally; never update an existing profile.
 await pool.query('insert into profiles(user_id,name,phone) values($1,$1,$2)',[userId,number]);
 await pool.query(`insert into otp_challenges(id,user_id,destination,purpose,provider,status,expires_at,attempts,max_attempts,cooldown_until)
 values($1,$2,$3,'phone_verification','arkesel','pending',now()+interval '5 minutes',0,5,now())`,[challengeId,userId,number]);
 let failPersist=false;
 const query=async(client,text,params)=>{
  if(failPersist && text.includes('confirm_phone_verification')) throw new Error('Injected phone persistence failure');
  return (await client.query(text,params)).rows;
 };
 const db={getSql:async()=>({query:(text,params)=>query(pool,text,params)}),withTransaction:async(work)=>{
  const client=await pool.connect();
  try {await client.query('BEGIN');const result=await work({query:(text,params)=>query(client,text,params)});await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }};
 const dependencies={
  '@/lib/db':db,'../../../../lib/db':db,
  '@/lib/security/rate-limit.server':{enforceRateLimit:async()=>{}},
  '../../../../lib/security/rate-limit.server':{enforceRateLimit:async()=>{}},
  './registry.server':{getOtpAdapter:()=>({key:'arkesel',verify:async()=>({code:'verified'})})},
  '@tanstack/react-start':{createServerFn:serverFunctionStub},
  './middleware':{authMiddleware:{},getAuthenticatedUserId:()=>userId},
  '../../../../lib/security/merchant-sensitive.server':{},
 };
 const account=loadTypeScript('src/modules/identity/internal/auth/account.functions.ts',dependencies);
 return {
  verify:()=>account.markPhoneVerified({data:{challengeId,code:'123456'},context:{}}),
  failWrite:()=>{failPersist=true;},
  changeProvider:()=>pool.query("update otp_challenges set provider='resend' where id=$1",[challengeId]),
  state:async()=>(await pool.query('select status,phone_applied_at from otp_challenges where id=$1',[challengeId])).rows[0],
  cleanup:async()=>{await pool.query('delete from otp_challenges where id=$1',[challengeId]);await pool.query('delete from profiles where user_id=$1',[userId]);await pool.query('delete from "user" where id=$1',[userId]);},
 };
}

test('phone OTP consumption rolls back if profile persistence fails',async()=>{
 const fixture=await phoneOtpFixture();
 try{
  fixture.failWrite();await assert.rejects(fixture.verify(),/Injected phone persistence failure/);
  assert.deepEqual(await fixture.state(),{status:'pending',phone_applied_at:null});
 }finally{await fixture.cleanup();}
});

test('phone OTP atomically records verification and rejects replay',async()=>{
 const fixture=await phoneOtpFixture();
 try {
  assert.equal((await fixture.verify()).verified,true);
  const state=await fixture.state();assert.equal(state.status,'verified');assert.ok(state.phone_applied_at);
  await assert.rejects(fixture.verify(),/invalid|consumed|locked/);
 }finally{await fixture.cleanup();}
});


test('SMS verification refuses challenges issued by the email adapter',async()=>{
 const fixture=await phoneOtpFixture();
 try {
  await fixture.changeProvider();await assert.rejects(fixture.verify(),/invalid|expired|locked/);
  assert.deepEqual(await fixture.state(),{status:'pending',phone_applied_at:null});
 }finally{await fixture.cleanup();}
});

test('concurrent phone verification applies one proof',async()=>{
 const fixture=await phoneOtpFixture();
 try {
  const results=await Promise.allSettled(Array.from({length:4},()=>fixture.verify()));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.ok((await fixture.state()).phone_applied_at);
 }finally{await fixture.cleanup();}
});
