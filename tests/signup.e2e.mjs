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
const email=`signup-${suffix}@example.test`;
const password=randomBytes(24).toString('base64url');
const phone=`05${String(parseInt(suffix.slice(0,6),16)).padStart(8,'0')}`;
const db=new pg.Client({connectionString:database});
await db.connect();
try {
 browser('--ignore-https-errors','open',`https://${domain}/login`);
 browser('set','viewport','390','844');
 click('New here? Create an account');
 fill('Name','Synthetic Beta Customer');fill('Phone number',phone);fill('Email',email);fill('Password',password);
 click('Create account');
 await wait(()=>evaluate('document.body.innerText.includes("Verify your email")'),'Signup did not reach verification');
 let message;
 await wait(async()=>{
  const response=await fetch(`${emailBase}/emails`,{headers:{authorization:`Bearer ${process.env.RESEND_API_KEY}`}});
  assert.equal(response.status,200);const inbox=await response.json();message=inbox.data.find(item=>item.to.includes(email));return Boolean(message);
 },'Local verification email not received');
 if(!message.text){const response=await fetch(`${emailBase}/emails/${message.id}`,{headers:{authorization:`Bearer ${process.env.RESEND_API_KEY}`}});message=await response.json();}
 const code=message.text.match(/code is (\d{6})/)[1];
 assert.equal((await db.query('select "emailVerified" from "user" where email=$1',[email])).rows[0].emailVerified,false);
 browser('find','placeholder','000000','fill',code);click('Verify email');
 await wait(()=>evaluate('location.pathname==="/"'),'Email verification and login did not return to marketplace');
 const user=(await db.query('select id,"emailVerified" from "user" where email=$1',[email])).rows[0];assert.equal(user.emailVerified,true);
 assert.equal((await db.query('select name from profiles where user_id=$1',[user.id])).rows[0].name,'Synthetic Beta Customer');
 browser('open',`https://${domain}/profile`);
 await wait(()=>evaluate('document.querySelector("h1")?.textContent==="My profile"'),'Authenticated profile unavailable');
 fill('Name','Synthetic Updated Customer');fill('Delivery address','1 Synthetic Test Avenue');click('Save profile');
 await wait(()=>evaluate('document.body.innerText.includes("Profile updated successfully.")'),'Profile save failed');
 browser('reload');
 assert.equal(evaluate('[...document.querySelectorAll("label")].find(label=>label.textContent==="Name").querySelector("input").value'),'Synthetic Updated Customer');
 assert.equal((await db.query('select address from profiles where user_id=$1',[user.id])).rows[0].address,'1 Synthetic Test Avenue');
 browser('open',`https://staff.${domain}/admin`);
 assert.match(evaluate('document.body.innerText'),/Employee administrator sign in/,'Marketplace session cookie must not reach staff portal');
 browser('open',`https://festus.${domain}/admin`);
 assert.match(evaluate('document.body.innerText'),/Main Admin sign in/,'Marketplace session cookie must not reach executive portal');
 console.log('PASS: mobile-width customer signup, simulated email delivery, OTP verification, real login, profile update/reload, and browser session isolation');
}finally{
 // Delete only the synthetic fixture created by this run, including its sessions.
 const user=(await db.query('select id from "user" where email=$1',[email])).rows[0];
 if(user){await db.query('delete from otp_challenges where user_id=$1',[user.id]);await db.query('delete from profiles where user_id=$1',[user.id]);await db.query('delete from "user" where id=$1',[user.id]);}
 await db.end();
}
