import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from 'better-auth/crypto';

const database=process.env.DATABASE_URL,host=process.env.ELEMARKET_STAFF_HOST;
if(!database || new URL(database).hostname!=='127.0.0.1' || !new URL(database).pathname.endsWith('_test') || host!=='staff.elemarket.localhost' || !process.env.ELEMARKET_TEST_CA) throw new Error('Local synthetic staff/TLS fixture only');
const ca=readFileSync(process.env.ELEMARKET_TEST_CA),cookies=new Map();
function request(path,body){return new Promise((resolve,reject)=>{
 const text=JSON.stringify(body);const req=https.request({hostname:host,port:443,path,method:'POST',ca,lookup:(_host,options,cb)=>options.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4),headers:{origin:`https://${host}`,'content-type':'application/json','content-length':Buffer.byteLength(text),cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; ')}},res=>{
  for(const line of res.headers['set-cookie']??[]){const pair=line.split(';')[0],split=pair.indexOf('=');cookies.set(pair.slice(0,split),pair.slice(split+1));}
  let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>{let body;try{body=JSON.parse(data);}catch{body=null;}resolve({status:res.statusCode,body});});
 });req.on('error',reject);req.end(text);
});}
function totp(secret){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const c of secret.replace(/=/g,'').toUpperCase())bits+=alphabet.indexOf(c).toString(2).padStart(5,'0');const key=Buffer.from(bits.match(/.{8}/g).map(b=>parseInt(b,2)));const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const digest=createHmac('sha1',key).update(counter).digest();return String((digest.readUInt32BE(digest.at(-1)&15)&0x7fffffff)%1000000).padStart(6,'0');}
const browser=(...args)=>{try{const result=JSON.parse(execFileSync('coderabbit-agent-browser',[...args,'--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));assert.equal(result.success,true);return result.data;}catch{throw new Error(`Browser ${args[0]} failed; sensitive arguments omitted`);}};
const evaluate=code=>browser('eval',code).result;
const wait=async(predicate,message)=>{for(let n=0;n<60;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,200));}throw new Error(message);};
const id=`staff_${randomUUID().replaceAll('-','')}`,email=`${id}@example.test`,password=randomBytes(24).toString('base64url');
const db=new pg.Client({connectionString:database});await db.connect();
try{
 await db.query('insert into "user"(id,name,email,"emailVerified",role) values($1,\'Synthetic Support Staff\',$2,true,\'admin\')',[id,email]);
 await db.query('insert into account(id,"accountId","providerId","userId",password,"updatedAt") values($1,$2,\'credential\',$2,$3,now())',[`account_${id}`,id,await hashPassword(password)]);
 await db.query("insert into admin_staff_roles(user_id,staff_role,assigned_reason) values($1,'support','Synthetic browser employee fixture')",[id]);
 let result=await request('/api/auth/sign-in/email',{email,password});assert.equal(result.status,200);
 result=await request('/api/auth/two-factor/enable',{password});assert.equal(result.status,200);
 const secret=new URL(result.body.totpURI).searchParams.get('secret');
 result=await request('/api/auth/two-factor/verify-totp',{code:totp(secret)});assert.equal(result.status,200);
 result=await request('/api/auth/sign-out',{});assert.equal(result.status,200);cookies.clear();
 browser('--ignore-https-errors','open',`https://${host}/admin`);browser('set','viewport','390','844');
 browser('find','label','Administrator email','fill',email);browser('find','label','Password','fill',password);
 browser('find','role','button','click','--name','Sign in to admin','--exact');
 await wait(()=>evaluate('location.pathname==="/two-factor"'),'Staff password did not reach TOTP challenge');
 assert.equal(evaluate('document.body.innerText.includes("Support Inbox")'),false);
 browser('find','placeholder','000000','fill',totp(secret));browser('find','role','button','click','--name','Verify and continue','--exact');
 await wait(()=>evaluate('location.pathname==="/admin/support" && document.querySelector("h1")?.textContent==="Support Inbox"'),'Staff TOTP did not reach authorized support page');
 assert.equal(evaluate('document.documentElement.scrollWidth>innerWidth'),false);
 assert.equal(evaluate('Array.from(document.links).some(a=>a.pathname==="/admin/team")'),false);
 browser('open',`https://${host}/admin/team`);
 await wait(()=>evaluate('location.pathname==="/admin" || location.pathname==="/admin/"'),'Support employee could enter team management');
 browser('open',`https://${process.env.ELEMARKET_EXECUTIVE_HOST}/admin`);
 assert.match(evaluate('document.body.innerText'),/Main Admin sign in/);
 await db.query("update admin_staff_roles set status='suspended' where user_id=$1",[id]);
 browser('open',`https://${host}/admin/support`);
 await wait(()=>evaluate('location.pathname==="/admin" || location.pathname==="/admin/"'),'Suspended employee retained support workspace');
 assert.equal(evaluate('document.body.innerText.includes("Support Inbox")'),false);
 console.log('PASS: real staff password/TOTP browser login; scoped support navigation; HR route refusal; executive cookie isolation; active-session suspension enforced');
}finally{
 await db.query('delete from admin_staff_roles where user_id=$1',[id]);await db.query('delete from profiles where user_id=$1',[id]);await db.query('delete from "user" where id=$1',[id]);await db.end();
 browser('--ignore-https-errors','open','https://elemarket.localhost/');
}
