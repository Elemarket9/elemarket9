import assert from 'node:assert/strict';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomBytes,createHmac} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from 'better-auth/crypto';

// Actual Better Auth HTTP + PostgreSQL integration. The verified synthetic
// identity is a fixture; this test does NOT certify email delivery/verification.
const url=process.env.DATABASE_URL;
const caPath=process.env.ELEMARKET_TEST_CA;
if(!url || new URL(url).hostname!=='127.0.0.1' || !new URL(url).pathname.endsWith('_test') || !caPath) throw new Error('Disposable local PostgreSQL and ELEMARKET_TEST_CA required');
const host=process.env.ELEMARKET_EXECUTIVE_HOST;
const id=process.env.ELEMARKET_EXECUTIVE_USER_ID;
if(!host?.endsWith('.localhost') || id!=='audit-executive') throw new Error('This integration fixture is limited to audit-executive on localhost');
const ca=readFileSync(caPath);const cookies=new Map();
const password=randomBytes(32).toString('base64url');const email='executive@audit.example.test';
const db=new pg.Client({connectionString:url});
function request(path,body,origin=`https://${host}`){
 return new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:JSON.stringify(body);
  const req=https.request({hostname:host,port:443,path,method:data?'POST':'GET',ca,lookup:(_h,options,cb)=>options.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4),headers:{origin,'content-type':'application/json',...(data?{'content-length':Buffer.byteLength(data)}:{}),cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}},res=>{
   for(const line of res.headers['set-cookie']??[]){const [pair]=line.split(';');const split=pair.indexOf('=');cookies.set(pair.slice(0,split),pair.slice(split+1));assert.ok(!/;\s*Domain=/i.test(line),'Auth cookies must be host-only');assert.match(line,/;\s*Secure/i);assert.match(line,/;\s*HttpOnly/i);}
   let text='';res.on('data',c=>text+=c);res.on('end',()=>{let body;try{body=JSON.parse(text);}catch{body=text;}resolve({status:res.statusCode,body});});
  });req.on('error',reject);if(data)req.write(data);req.end();
 });
}
function totp(secret){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const c of secret.replace(/=/g,'').toUpperCase())bits+=alphabet.indexOf(c).toString(2).padStart(5,'0');const key=Buffer.from(bits.match(/.{8}/g).map(b=>parseInt(b,2)));const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const digest=createHmac('sha1',key).update(counter).digest();const offset=digest.at(-1)&15;return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}
try{
 await db.connect();
 const existing=(await db.query('select id,email,name from "user" where id=$1',[id])).rows;
 if(existing.length){
  assert.equal(existing[0].email,email);assert.equal(existing[0].name,'Synthetic Executive');
  await db.query('delete from admin_staff_roles where user_id=$1',[id]);
  await db.query('delete from "user" where id=$1',[id]);
 }
 await db.query('BEGIN');
 await db.query('insert into "user"(id,name,email,"emailVerified",role) values($1,$2,$3,true,\'admin\')',[id,'Synthetic Executive',email]);
 await db.query('insert into account(id,"accountId","providerId","userId",password,"updatedAt") values($1,$2,\'credential\',$2,$3,now())',[`account-${id}`,id,await hashPassword(password)]);
 await db.query('insert into admin_staff_roles(user_id,staff_role,status,assigned_reason) values($1,\'owner\',\'active\',\'Synthetic local authentication integration fixture\')',[id]);
 await db.query('COMMIT');
 let r=await request('/api/auth/sign-in/email',{email,password});assert.equal(r.status,200,'Password login for TOTP setup');
 r=await request('/api/auth/two-factor/enable',{password});assert.equal(r.status,200,'Enable authenticator');assert.ok(r.body.totpURI);
 const backupCodes=r.body.backupCodes;assert.ok(Array.isArray(backupCodes) && backupCodes.length>0);
 const secret=new URL(r.body.totpURI).searchParams.get('secret');
 r=await request('/api/auth/two-factor/verify-totp',{code:totp(secret)});assert.equal(r.status,200,'Confirm initial TOTP');
 r=await request('/api/auth/sign-out',{});assert.equal(r.status,200);cookies.clear();
 if(process.env.ELEMARKET_EXECUTIVE_BROWSER!=='1'){
 r=await request('/api/auth/sign-in/email',{email,password});assert.equal(r.status,200);assert.equal(r.body.twoFactorRedirect,true,'Password alone must require TOTP');
 r=await request('/api/auth/get-session');assert.ok(!r.body?.user,'No authenticated session before TOTP');
 r=await request('/api/auth/two-factor/verify-totp',{code:'invalid'});assert.notEqual(r.status,200,'Invalid TOTP refused');
 r=await request('/api/auth/two-factor/verify-totp',{code:totp(secret)});assert.equal(r.status,200,'Actual TOTP login');
 r=await request('/api/auth/get-session');assert.equal(r.body.user.id,id);
 console.log('PASS: real Better Auth password + TOTP enrollment and login; no session before TOTP; secure host-only cookies');
 r=await request('/api/executive/face');assert.equal(r.status,200);assert.equal(r.body.available,false);
 r=await request('/api/auth/executive/face-sign-in',{challengeId:'00000000-0000-4000-8000-000000000000',pin:'SyntheticPassphrase123',frames:['A'.repeat(500),'A'.repeat(500),'A'.repeat(500)]});assert.notEqual(r.status,200);
 console.log('PASS: shared-environment executive face API unavailable and face login rejected');
 r=await request('/api/auth/change-password',{currentPassword:password,newPassword:password+'a'},'https://attacker.invalid');assert.equal(r.status,403);
 console.log('PASS: foreign-origin credential mutation rejected');
 r=await request('/api/auth/change-password',{currentPassword:password,newPassword:password+'b'},`https://${process.env.ELEMARKET_DOMAIN}`);assert.equal(r.status,403,'Sibling marketplace origin must not mutate an executive session');
 console.log('PASS: sibling-portal credential mutation rejected');
 r=await request('/api/auth/sign-out',{});assert.equal(r.status,200);cookies.clear();
 r=await request('/api/auth/sign-in/email',{email,password});assert.equal(r.body.twoFactorRedirect,true);
 r=await request('/api/auth/two-factor/verify-backup-code',{code:backupCodes[0]});assert.equal(r.status,200,'Unused recovery code restores a TOTP-protected session');
 r=await request('/api/auth/get-session');assert.equal(r.body.user.id,id);
 r=await request('/api/auth/sign-out',{});assert.equal(r.status,200);cookies.clear();
 r=await request('/api/auth/sign-in/email',{email,password});assert.equal(r.body.twoFactorRedirect,true);
 r=await request('/api/auth/two-factor/verify-backup-code',{code:backupCodes[0]});assert.notEqual(r.status,200,'Consumed recovery code cannot be replayed');
 r=await request('/api/auth/get-session');assert.ok(!r.body?.user);
 console.log('PASS: actual executive backup-code recovery succeeds once and replay cannot create a session');
 }
 if(process.env.ELEMARKET_EXECUTIVE_BROWSER==='1'){
  const browser=(...args)=>{try{const r=JSON.parse(execFileSync('coderabbit-agent-browser',[...args,'--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));assert.equal(r.success,true);return r.data;}catch{throw new Error(`Browser ${args[0]} failed; sensitive arguments omitted`);}};
  const evaluate=code=>browser('eval',code).result;
  const wait=async(predicate,message)=>{for(let n=0;n<60;n++){try{if(predicate())return;}catch{/* A document replacement can invalidate the browser execution context. */}await new Promise(resolve=>setTimeout(resolve,200));}throw new Error(message);};
  try{
   browser('--ignore-https-errors','open',`https://${host}/admin`);browser('set','viewport','390','844');
   browser('find','label','Administrator email','fill',email);browser('find','label','Password','fill',password);
   browser('find','role','button','click','--name','Sign in to admin','--exact');
   await wait(()=>evaluate('location.pathname==="/two-factor"'),'Executive password did not reach TOTP').catch(e=>{throw new Error(`${e.message}; page: ${evaluate("document.body.innerText").slice(0,1000)}`);});
   browser('find','placeholder','000000','fill',totp(secret));browser('find','role','button','click','--name','Verify and continue','--exact');
   await wait(()=>evaluate('location.pathname==="/admin/dashboard" && document.body.innerText.includes("Operations overview")'),'Executive TOTP did not load dashboard');
   for(const [path,title] of [['dashboard','Operations overview'],['team','Team, roles & permissions'],['partners','Provider administration'],['security','Administrator 2FA is active']]){
    browser('open',`https://${host}/admin/${path}`);
    await wait(()=>evaluate(`document.querySelector("h1")?.textContent===${JSON.stringify(title)}`),`Executive ${path} failed to render`);
    assert.equal(evaluate('document.documentElement.scrollWidth>innerWidth'),false,`${path} mobile overflow`);
    browser('reload');await wait(()=>evaluate(`document.querySelector("h1")?.textContent===${JSON.stringify(title)}`),`${path} refresh failed`);
   }
   browser('open',`https://${process.env.ELEMARKET_STAFF_HOST}/admin`);
   assert.match(evaluate('document.body.innerText'),/Employee administrator sign in/);
   console.log('PASS: executive real browser password/TOTP; dashboard, team, providers, security and refresh; mobile layout; staff host isolation');
  }finally{
   browser('--ignore-https-errors','open',`https://${host}/admin`);
   assert.equal(evaluate("fetch('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)"),200);
   browser('--ignore-https-errors','open','https://elemarket.localhost/');
  }
 }
}finally{await db.end();}
