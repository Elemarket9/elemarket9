import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import pg from 'pg';

// Real browser + Better Auth + PostgreSQL. Delivery is simulated locally;
// this does not establish ownership of an actual email address.
const domain=process.env.ELEMARKET_DOMAIN;
const emailBase=process.env.RESEND_BASE_URL;
const database=process.env.DATABASE_URL;
if(domain!=='elemarket.localhost' || emailBase!=='http://127.0.0.1:4010' || !database || new URL(database).hostname!=='127.0.0.1' || !new URL(database).pathname.endsWith('_test')) throw new Error('Explicit local synthetic environment required');
const browser=(...args)=>{
 try {const result=JSON.parse(execFileSync('coderabbit-agent-browser',[...args,'--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));assert.equal(result.success,true);return result.data;}
 catch {throw new Error(`Browser ${args[0]} failed; sensitive arguments omitted`);}
};
const evaluate=script=>browser('eval',script).result;
const fill=(label,value)=>browser('find','label',label,'fill',value);
const click=name=>browser('find','role','button','click','--name',name,'--exact');
const wait=async(predicate,message)=>{for(let n=0;n<40;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error(message);};
const suffix=randomBytes(8).toString('hex');
const email=`merchant-${suffix}@example.test`;
const password=randomBytes(24).toString('base64url');
const phone=`05${String(parseInt(suffix.slice(0,6),16)).padStart(8,'0')}`;
const db=new pg.Client({connectionString:database});
await db.connect();
try {
 browser('--ignore-https-errors','open',`https://seller.${domain}/merchant/register`);
 browser('set','viewport','390','844');
 fill('Your name','Synthetic Merchant Contact');fill('Email',email);fill('Password',password);
 fill('Legal/business name','Synthetic Merchant Business');fill('Business registration number','SYNTHETIC-REGISTRATION');
 browser('fill','input[autocomplete="off"]:not([minlength])','SYNTHETIC-TAX-ID');fill('Business address','1 Synthetic Test Avenue');fill('Business phone',phone);
 browser('check','fieldset label:nth-of-type(1) input');browser('check','fieldset label:nth-of-type(2) input');
 assert.equal(evaluate(`document.querySelector("input[autocomplete=off]:not([minlength])").value.length`),16,'Taxpayer input must be filled before submitting');
 click('Create merchant account');
 await wait(()=>evaluate('document.body.innerText.includes("Verify your email")'),'Merchant signup did not reach verification');
 let message;
 await wait(async()=>{
  const response=await fetch(`${emailBase}/emails`,{headers:{authorization:`Bearer ${process.env.RESEND_API_KEY}`}});
  assert.equal(response.status,200);const inbox=await response.json();message=inbox.data.find(item=>item.to.includes(email));return Boolean(message);
 },'Local verification email not received');
 if(!message.text){const response=await fetch(`${emailBase}/emails/${message.id}`,{headers:{authorization:`Bearer ${process.env.RESEND_API_KEY}`}});message=await response.json();}
 const code=message.text.match(/code is (\d{6})/)[1];
 browser('find','placeholder','000000','fill',code);click('Verify');
 await wait(async()=>Boolean((await db.query('select id from merchant_applications where user_id in(select id from "user" where email=$1)',[email])).rows[0]),'Merchant application was not persisted');
 const user=(await db.query('select id,"emailVerified" from "user" where email=$1',[email])).rows[0];assert.equal(user.emailVerified,true);
 const application=(await db.query('select status,catalog_categories from merchant_applications where user_id=$1',[user.id])).rows[0];
 assert.equal(application.status,'pending');assert.equal(application.catalog_categories.length,2);
 await wait(()=>evaluate('document.body.innerText.includes("Your application is saved.")'),'Saved merchant application is stranded when SMS delivery is unavailable');
 assert.equal((await db.query('select phone_verified_at from profiles where user_id=$1',[user.id])).rows[0].phone_verified_at,null);
 browser('find','role','link','click','--name','View application status');
 await wait(()=>evaluate('document.body.innerText.includes("Your merchant application has been received")'),'Pending status did not load');
 assert.equal((await db.query('select count(*)::int as n from merchant_accounts where user_id=$1',[user.id])).rows[0].n,0,'Pending merchant must not gain tenant access');
 console.log('PASS: merchant signup, simulated email verification, multiple categories, saved pending application and honest recovery when SMS is unavailable; no phone proof or merchant access fabricated');
}finally{
 const user=(await db.query('select id from "user" where email=$1',[email])).rows[0];
 if(user){await db.query('delete from merchant_applications where user_id=$1',[user.id]);await db.query('delete from otp_challenges where user_id=$1',[user.id]);await db.query('delete from profiles where user_id=$1',[user.id]);await db.query('delete from "user" where id=$1',[user.id]);}
 await db.end();
}
