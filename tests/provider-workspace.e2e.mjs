import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from 'better-auth/crypto';

const database=process.env.DATABASE_URL,host=process.env.ELEMARKET_PROVIDER_HOST;
if(!database || new URL(database).hostname!=='127.0.0.1' || !new URL(database).pathname.endsWith('_test') || host!=='partners.elemarket.localhost') throw new Error('Local synthetic workspace fixture only');
const browser=(...args)=>{try{const result=JSON.parse(execFileSync('coderabbit-agent-browser',[...args,'--json'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));assert.equal(result.success,true);return result.data;}catch{throw new Error(`Browser ${args[0]} failed; sensitive arguments omitted`);}};
const evaluate=code=>{new Function(code);return browser('eval',code).result;};
const click=(role,name)=>browser('find','role',role,'click','--name',name,'--exact');
const fill=(label,value)=>browser('find','label',label,'fill',value);
const wait=async(predicate,message)=>{for(let n=0;n<60;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,200));}throw new Error(message);};
const id=`provider_${randomUUID().replaceAll('-','')}`,org=`org_${id}`;
const email=`${id}@example.test`,password=randomBytes(24).toString('base64url');
const db=new pg.Client({connectionString:database});await db.connect();
try{
 await db.query(`insert into "user"(id,name,email,"emailVerified") values($1,'Synthetic Workspace Provider',$2,true)`,[id,email]);
 await db.query(`insert into account(id,"accountId","providerId","userId",password,"updatedAt") values($1,$2,'credential',$2,$3,now())`,[`account_${id}`,id,await hashPassword(password)]);
 await db.query("insert into partner_organizations(id,name,status) values($1,'Synthetic Workspace Provider','active')",[org]);
 await db.query("insert into partner_organization_users(organization_id,user_id,role) values($1,$2,'owner')",[org,id]);
 await db.query("insert into partner_organization_capabilities(organization_id,capability) values($1,'delivery'),($1,'customer_financing'),($1,'merchant_financing')",[org]);
 browser('--ignore-https-errors','open',`https://${host}/provider/login`);
 browser('set','viewport','390','844');fill('Business email',email);fill('Password',password);click('button','Sign in to Provider Hub');
 await wait(()=>evaluate('location.pathname==="/provider/dashboard" && document.body.innerText.includes("Synthetic Workspace Provider")'),'Provider dashboard did not load');
 assert.equal(evaluate('document.documentElement.scrollWidth>innerWidth'),false);
 for(const [path,text] of [['financing','No cases match this queue.'],['delivery','No jobs match this queue.']]){
  browser('open',`https://${host}/provider/${path}`);
  await wait(()=>evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`),`${path} workbench did not load`);
  assert.equal(evaluate('document.querySelector("h1").textContent'),'Synthetic Workspace Provider');
  assert.equal(evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  browser('reload');await wait(()=>evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`),`${path} workbench failed refresh`);
 }
 browser('open',`https://${process.env.ELEMARKET_EXECUTIVE_HOST}/admin`);
 assert.match(evaluate('document.body.innerText'),/Main Admin sign in/);
 await db.query("update partner_organizations set status='suspended' where id=$1",[org]);
 browser('open',`https://${host}/provider/dashboard`);
 await wait(()=>evaluate('document.body.innerText.includes("Provider approval required")'),'Suspended provider retained workspace');
 for(const [path,text] of [['financing','Financing partner access required'],['delivery','Delivery partner access required']]){
  browser('open',`https://${host}/provider/${path}`);
  await wait(()=>evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`),`Suspension response missing for ${path}`).catch(e=>{throw new Error(`${e.message}; page: ${evaluate("document.body.innerText").slice(0,1000)}`);});
 }
 console.log('PASS: real provider password login; both scoped empty workbenches and refresh; mobile layout; executive cookie isolation; suspension denies existing session');
}finally{
 await db.query('delete from partner_organizations where id=$1',[org]);
 await db.query('delete from profiles where user_id=$1',[id]);
 await db.query('delete from "user" where id=$1',[id]);await db.end();
 browser('--ignore-https-errors','open','https://elemarket.localhost/');
}
