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
const email=`provider-${suffix}@example.test`;
const password=randomBytes(24).toString('base64url');
const phone=`05${String(parseInt(suffix.slice(0,6),16)).padStart(8,'0')}`;
const db=new pg.Client({connectionString:database});
await db.connect();
try {
 browser('--ignore-https-errors','open',`https://partners.${domain}/provider/signup`);
 browser('set','viewport','390','844');
 fill('Contact name','Synthetic Provider Contact');fill('Organization name','Synthetic Provider Organization');fill('Business email',email);fill('Password',password);fill('Phone',phone);
 browser('find','label','Customer financing','check');browser('find','label','Delivery/logistics','check');
 fill('Describe your service and operating process','Synthetic local provider for Developer Beta tests only.');
 click('Continue and verify business email');
 await wait(()=>evaluate('document.body.innerText.includes("Enter the 6-digit code")'),'Provider signup did not reach verification');
 let message;
 await wait(async()=>{
  const response=await fetch(`${emailBase}/emails`,{headers:{authorization:`Bearer ${process.env.RESEND_API_KEY}`}});
  assert.equal(response.status,200);const inbox=await response.json();message=inbox.data.find(item=>item.to.includes(email));return Boolean(message);
 },'Local verification email not received');
 if(!message.text){const response=await fetch(`${emailBase}/emails/${message.id}`,{headers:{authorization:`Bearer ${process.env.RESEND_API_KEY}`}});message=await response.json();}
 const code=message.text.match(/code is (\d{6})/)[1];
 browser('fill','input[inputmode="numeric"]',code);click('Verify and submit application');
 await wait(()=>evaluate('document.body.innerText.includes("Your provider application is under review.")'),'Provider application did not submit');
 const user=(await db.query('select id,"emailVerified" from "user" where email=$1',[email])).rows[0];assert.equal(user.emailVerified,true);
 const application=(await db.query('select status,requested_capabilities,processing_mode from provider_gateway_applications where applicant_user_id=$1',[user.id])).rows[0];
 assert.equal(application.status,'review');assert.equal(application.processing_mode,'manual');assert.deepEqual(application.requested_capabilities.sort(),['customer_financing','delivery']);
 browser('open',`https://partners.${domain}/provider/status`);browser('reload');
 assert.match(evaluate('document.body.innerText'),/Synthetic Provider Organization/);
 assert.equal((await db.query('select count(*)::int as n from partner_organization_users where user_id=$1',[user.id])).rows[0].n,0,'Pending application must not grant operational membership');
 console.log('PASS: provider signup, simulated email verification, multi-capability manual application and persisted pending status without operational membership');
}finally{
 const user=(await db.query('select id from "user" where email=$1',[email])).rows[0];
 if(user){await db.query('delete from provider_gateway_applications where applicant_user_id=$1',[user.id]);await db.query('delete from otp_challenges where user_id=$1',[user.id]);await db.query('delete from profiles where user_id=$1',[user.id]);await db.query('delete from "user" where id=$1',[user.id]);}
 await db.end();
}
