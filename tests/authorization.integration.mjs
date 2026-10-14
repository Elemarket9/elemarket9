import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {loadTypeScript,serverFunctionStub} from '../scripts/helpers/load-typescript.mjs';
import * as policy from '../src/modules/identity/internal/auth/admin-permission-policy.mjs';
import * as portals from '../src/lib/security/portal-policy.mjs';
import * as launch from '../src/lib/security/launch-profile.mjs';

const url=process.env.ELEMARKET_INTEGRATION_DATABASE_URL;
if(process.env.RUN_DB_INTEGRATION!=='1' || !url || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_test')) throw new Error('Disposable local migrated PostgreSQL required');
if(!portals.getPortalConfiguration()) throw new Error('Five-portal configuration must be enabled for authorization tests');
const pool=new pg.Pool({connectionString:url,max:8,options:'-c statement_timeout=10000'});
test.after(()=>pool.end());

// Real handlers, authorization queries, schema validators and transactions.
// HTTP session resolution/freshness and rate limiting are explicit substitutes;
// actual password/TOTP and HTTP host checks are covered by separate suites.
async function fixture(){
 const suffix=randomUUID(); const user=`authz_${suffix}`; const merchant=`merchant_${suffix}`;
 const product=`product_${suffix}`; let failAudit=false;
 let request=new Request(`https://${process.env.ELEMARKET_SELLER_HOST}/`,{headers:{host:process.env.ELEMARKET_SELLER_HOST}});
 const query=async(client,text,params)=>{
  if(failAudit && text.includes('record_audit_event')) throw new Error('Injected audit persistence failure');
  return (await client.query(text,params)).rows;
 };
 const db={getSql:async()=>({query:(text,params)=>query(pool,text,params)}),withTransaction:async work=>{
  const client=await pool.connect();try{await client.query('BEGIN');const result=await work({query:(text,params)=>query(client,text,params)});await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }};
 const dependencies={
  '@/lib/db':db,'../../../../lib/db':db,
  '@/lib/security/launch-profile.mjs':launch,
  '@/modules/merchants/public/kyb/index.server':{},
  '@tanstack/react-start':{createServerFn:serverFunctionStub},
  '@tanstack/react-start/server':{getRequest:()=>request},
  '@/modules/identity/public/auth/middleware':{authMiddleware:{},getAuthenticatedUserId:context=>context.userId},
  '@/modules/identity/public/auth/verify.server':{requireFreshSession:async()=>user},
  './verify.server':{requireUserId:async()=>user},
  './server':{auth:{api:{getSession:async()=>({user:{id:user},session:{id:`session_${suffix}`,createdAt:new Date()}})}}},
  './admin-permission-policy.mjs':policy,
  '@/modules/identity/public/auth/admin-permission-policy.mjs':policy,
  '@/lib/security/portal-policy.mjs':portals,'./portal-policy.mjs':portals,
  '@/lib/security/rate-limit.server':{enforceRateLimit:async()=>{}},
  '@/modules/logistics/public/adapters/location.server':{},
  '@/modules/financing/public/merchant-finance.server':{},
  '@/modules/merchants/public/enterprise-catalog.server':{},
  '@/modules/merchants/public/enterprise-integration.server':{},
  '@/modules/merchants/public/brand-integration.server':{},
  '@/modules/merchants/public/enterprise-multilocation.server':{},
 };
 dependencies['@/lib/security/portal-access.server']=loadTypeScript('src/lib/security/portal-access.server.ts',dependencies);
 const authorization=loadTypeScript('src/modules/identity/internal/auth/authorization.server.ts',dependencies);
 dependencies['@/modules/identity/public/auth/authorization.server']=authorization;
 const moderation=loadTypeScript('src/modules/administration/internal/transport/admin/moderation.functions.ts',dependencies);
 const dashboard=loadTypeScript('src/modules/merchants/internal/transport/merchant/dashboard.functions.ts',dependencies);
 const merchantReview=loadTypeScript('src/modules/merchants/internal/transport/admin/merchant-review.functions.ts',dependencies);
 const partnerAdmin=loadTypeScript('src/modules/administration/internal/transport/admin/partners.functions.ts',dependencies);
 const partnerAccess=loadTypeScript('src/lib/partner/authorization.server.ts',dependencies);
 const staff=loadTypeScript('src/modules/administration/internal/transport/admin/staff.functions.ts',dependencies);
 const support=loadTypeScript('src/modules/support/internal/support.functions.ts',dependencies);
 const provider=loadTypeScript('src/modules/administration/internal/transport/provider/gateway.functions.ts',dependencies);
 await pool.query('insert into "user"(id,name,email,"emailVerified") values($1,$1,$2,true)',[user,`${user}@example.test`]);
 await pool.query("insert into merchants(id,name,category,status,verified,tier,address,city,neighborhood,lat,lon,catalog_categories) values($1,'Synthetic Merchant','electronics','active',true,'merchant','1 Test Street','Accra','Test',5.6,-0.18,ARRAY['electronics'])",[merchant]);
 await pool.query('insert into merchant_accounts(merchant_id,user_id) values($1,$2)',[merchant,user]);
 await pool.query("insert into products(id,merchant_id,name,category,price,currency,stock,description,status) values($1,$2,'Synthetic Product','electronics',100,'GHS',1,'Test','active')",[product,merchant]);
 return {user,merchant,product,moderation,dashboard,staff,support,provider,authorization,merchantReview,partnerAdmin,partnerAccess,
  call:(fn,data={},userId=user)=>fn({data,context:{userId}}),
  failAudit:()=>{failAudit=true;},
  host:host=>{request=new Request(`https://${host}/`,{headers:{host}});},
  cleanup:async()=>{
   await pool.query('delete from support_conversations where customer_id=$1',[user]);
   await pool.query('delete from partner_organization_users where user_id=$1',[user]);
   await pool.query('delete from admin_staff_extra_roles where user_id=$1',[user]);
   await pool.query('delete from admin_staff_roles where user_id=$1',[user]);
   await pool.query('delete from merchant_inventory_adjustments where merchant_id=$1',[merchant]);
   await pool.query('delete from products where merchant_id=$1',[merchant]);
   await pool.query('delete from merchants where id=$1',[merchant]);
   await pool.query('delete from profiles where user_id=$1',[user]);
   await pool.query('delete from "user" where id=$1',[user]);
  }};
}
const productData=f=>({merchantId:f.merchant,productId:f.product,name:'Changed Product',category:'electronics',price:120,description:'Updated',returnable:true,returnWindowDays:14,warrantyMonths:12,fulfillmentType:'delivery',attributes:{}});

for(const operation of ['create','update','archive']) test(`merchant ${operation} rolls back when audit persistence fails`,async()=>{
 const f=await fixture();try{
  const before=(await pool.query('select id,name,status from products where merchant_id=$1 order by id',[f.merchant])).rows;
  f.failAudit();
  const fn={create:f.dashboard.createMerchantListing,update:f.dashboard.updateMerchantProduct,archive:f.dashboard.archiveMerchantProduct}[operation];
  await assert.rejects(f.call(fn,{...productData(f),stock:1}),/Injected audit persistence failure/);
  assert.deepEqual((await pool.query('select id,name,status from products where merchant_id=$1 order by id',[f.merchant])).rows,before,'Failed operation must not commit its product mutation');
 }finally{await f.cleanup();}
});

test('merchant membership, product ownership and portal gates reject cross-tenant writes',async()=>{
 const a=await fixture(),b=await fixture();try{
  await assert.rejects(a.call(a.dashboard.updateMerchantProduct,{...productData(b)}),/Merchant access denied/);
  await assert.rejects(a.call(a.dashboard.updateMerchantProduct,{...productData(a),productId:b.product}),/Product not found/);
  assert.equal((await pool.query('select name from products where id=$1',[b.product])).rows[0].name,'Synthetic Product');
  a.host(process.env.ELEMARKET_DOMAIN);
  await assert.rejects(a.call(a.dashboard.archiveMerchantProduct,{merchantId:a.merchant,productId:a.product}),/wrong portal/);
  a.host(process.env.ELEMARKET_SELLER_HOST);
  await pool.query("update merchant_accounts set status='suspended' where merchant_id=$1",[a.merchant]);
  await assert.rejects(a.call(a.dashboard.createMerchantListing,{...productData(a),stock:1}),/Merchant access denied/);
 }finally{await a.cleanup();await b.cleanup();}
});

test('concurrent inventory decrements cannot make stock negative',async()=>{
 const f=await fixture();try{
  const results=await Promise.allSettled([1,2].map(()=>f.call(f.dashboard.adjustMerchantInventory,{merchantId:f.merchant,productId:f.product,delta:-1,reason:'Synthetic stock race'})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.match(results.find(x=>x.status==='rejected').reason.message,/inventory would become invalid/);
  assert.equal((await pool.query('select stock from products where id=$1',[f.product])).rows[0].stock,0);
 }finally{await f.cleanup();}
});

test('successful merchant create, edit and archive each persist a matching audit event',async()=>{
 const f=await fixture();try{
  const created=await f.call(f.dashboard.createMerchantListing,{...productData(f),stock:2});
  assert.equal(created.status,'pending_review');
  assert.equal((await f.call(f.dashboard.updateMerchantProduct,{...productData(f),productId:created.productId})).status,'pending_review');
  assert.equal((await f.call(f.dashboard.archiveMerchantProduct,{merchantId:f.merchant,productId:created.productId})).status,'archived');
  assert.deepEqual((await pool.query('select event_type from audit_events where resource_id=$1 order by id',[created.productId])).rows.map(x=>x.event_type),['merchant.product.created','merchant.product.updated','merchant.product.archived']);
 }finally{await f.cleanup();}
});

test('custom staff grants enforce capability, assurance, suspension and portal boundaries',async()=>{
 const f=await fixture();const role=`audit_${randomUUID().replaceAll('-','')}`;
 try{
  f.host(process.env.ELEMARKET_STAFF_HOST);
  await pool.query('insert into admin_roles(role_key,display_name) values($1,\'Synthetic Staff\')',[role]);
  await pool.query("insert into admin_role_permissions(role_key,capability) values($1,'admin.staff.manage')",[role]);
  await pool.query("update \"user\" set role='admin' where id=$1",[f.user]);
  await assert.rejects(f.authorization.requireAdminForUserId(f.user,'admin.staff.directory'),/two-factor/);
  await pool.query('update "user" set "twoFactorEnabled"=true,"twoFactorEnabledAt"=now()-interval \'1 minute\' where id=$1',[f.user]);
  await assert.rejects(f.authorization.requireAdminForUserId(f.user,'admin.staff.directory'),/not provisioned/);
  await pool.query('insert into admin_staff_roles(user_id,staff_role) values($1,$2)',[f.user,role]);
  await f.authorization.requireAdminForUserId(f.user,'admin.staff.directory');
  await assert.rejects(f.authorization.requireAdminForUserId(f.user),/permission required/);
  await assert.rejects(f.authorization.requireAdminForUserId(f.user,'admin.finance.refunds'),/permission required/);
  await assert.rejects(f.authorization.requireMerchantAccessForUserId(f.merchant,f.user),/cross-role/);
  f.host(process.env.ELEMARKET_EXECUTIVE_HOST);
  await assert.rejects(f.authorization.requireAdminForUserId(f.user,'admin.staff.directory'),/wrong administration portal/);
  f.host(process.env.ELEMARKET_STAFF_HOST);
  await pool.query("update admin_staff_roles set status='suspended' where user_id=$1",[f.user]);
  await assert.rejects(f.authorization.requireAdminForUserId(f.user,'admin.staff.directory'),/not provisioned/);
 }finally{await f.cleanup();await pool.query('delete from admin_roles where role_key=$1',[role]);}
});

test('delegated HR cannot escalate and provisions only within its grant with session revocation',async()=>{
 const actor=await fixture(),target=await fixture();const role=`audit_${randomUUID().replaceAll('-','')}`;
 try{
  actor.host(process.env.ELEMARKET_STAFF_HOST);
  await pool.query('insert into admin_roles(role_key,display_name) values($1,\'Synthetic HR\')',[role]);
  await pool.query("insert into admin_role_permissions(role_key,capability) values($1,'admin.staff.manage'),($1,'admin.support')",[role]);
  await pool.query('update "user" set role=\'admin\',"twoFactorEnabled"=true,"twoFactorEnabledAt"=now()-interval \'1 minute\' where id=$1',[actor.user]);
  await pool.query('insert into admin_staff_roles(user_id,staff_role) values($1,$2)',[actor.user,role]);
  const grant={userId:target.user,staffRole:'support',status:'active',reason:'Synthetic delegated provisioning test'};
  await assert.rejects(actor.call(actor.staff.updateAdminStaff,grant),/Active merchant identities/);
  await pool.query('delete from merchant_accounts where user_id=$1',[target.user]);
  await assert.rejects(actor.call(actor.staff.updateAdminStaff,{...grant,staffRole:'operations'}),/outside your own authority/);
  await assert.rejects(actor.call(actor.staff.updateAdminStaff,{...grant,staffRole:'owner'}),/configured executive|Only a Main Administrator/);
  await assert.rejects(actor.call(actor.staff.updateAdminStaff,{...grant,userId:actor.user}),/own privileges/);
  await pool.query('insert into "session"(id,token,"userId","expiresAt","updatedAt") values($1,$2,$3,now()+interval \'1 day\',now())',[`session_${target.user}`,randomUUID(),target.user]);
  assert.deepEqual(await actor.call(actor.staff.updateAdminStaff,grant),{saved:true});
  assert.equal((await pool.query('select role from "user" where id=$1',[target.user])).rows[0].role,'admin');
  assert.equal((await pool.query('select count(*)::int n from "session" where "userId"=$1',[target.user])).rows[0].n,0);
  assert.equal((await pool.query("select count(*)::int n from audit_events where resource_id=$1 and event_type='admin.staff.role_changed'",[target.user])).rows[0].n,1);
 }finally{await target.cleanup();await actor.cleanup();await pool.query('delete from admin_roles where role_key=$1',[role]);}
});

test('support read and message append reject another customer conversation',async()=>{
 const a=await fixture(),b=await fixture();try{
  const thread=await a.call(a.support.getSupportConversation);
  const key=randomUUID();
  await a.call(a.support.sendSupportMessage,{conversationId:thread.id,body:'Synthetic support question',idempotencyKey:key});
  await a.call(a.support.sendSupportMessage,{conversationId:thread.id,body:'Synthetic support question',idempotencyKey:key});
  assert.equal((await a.call(a.support.refreshSupportConversation,{conversationId:thread.id})).messages.length,1);
  await assert.rejects(b.call(b.support.refreshSupportConversation,{conversationId:thread.id}),/unavailable/);
  await assert.rejects(b.call(b.support.sendSupportMessage,{conversationId:thread.id,body:'Cross tenant',idempotencyKey:randomUUID()}),/unavailable|unauthorized|not found|access/i);
 }finally{await a.cleanup();await b.cleanup();}
});

test('provider context requires one active membership and never exposes another organization',async()=>{
 const f=await fixture();const orgA=`org_${randomUUID()}`,orgB=`org_${randomUUID()}`;
 try{
  f.host(process.env.ELEMARKET_PROVIDER_HOST);
  assert.equal((await f.call(f.provider.getProviderGatewayContext)).authorized,false);
  await pool.query("insert into partner_organizations(id,name,status) values($1,'Synthetic Org A','active'),($2,'Synthetic Org B','active')",[orgA,orgB]);
  await pool.query("insert into partner_organization_users(organization_id,user_id,role) values($1,$2,'operator')",[orgA,f.user]);
  assert.equal((await f.call(f.provider.getProviderGatewayContext)).organizationId,orgA);
  await pool.query("update partner_organizations set status='suspended' where id=$1",[orgA]);
  assert.equal((await f.call(f.provider.getProviderGatewayContext)).authorized,false);
  await pool.query("update partner_organizations set status='active' where id=$1",[orgA]);
  await pool.query("insert into partner_organization_users(organization_id,user_id,role) values($1,$2,'operator')",[orgB,f.user]);
  await assert.rejects(f.call(f.provider.getProviderGatewayContext),/Multiple provider organizations/);
 }finally{await f.cleanup();await pool.query('delete from partner_organizations where id=any($1::text[])',[[orgA,orgB]]);}
});

async function reviewer(f){
 const role=`audit_${randomUUID().replaceAll('-','')}`;
 f.host(process.env.ELEMARKET_STAFF_HOST);
 await pool.query('insert into admin_roles(role_key,display_name) values($1,\'Synthetic Reviewer\')',[role]);
 await pool.query("insert into admin_role_permissions(role_key,capability) values($1,'admin.providers.manage'),($1,'admin.merchants.review')",[role]);
 await pool.query('update "user" set role=\'admin\',"twoFactorEnabled"=true,"twoFactorEnabledAt"=now()-interval \'1 minute\' where id=$1',[f.user]);
 await pool.query('insert into admin_staff_roles(user_id,staff_role) values($1,$2)',[f.user,role]);
 return role;
}

test('merchant approval requires contact proof and atomically activates multiple categories',async()=>{
 const admin=await fixture(),applicant=await fixture();const role=await reviewer(admin);
 const app=`application_${randomUUID()}`,challenge=`otp_${randomUUID().replaceAll('-','')}`;
 const phone='+2335'+String(parseInt(randomUUID().slice(0,8),16)%100000000).padStart(8,'0');let activated;
 try{
  await pool.query('delete from merchant_accounts where user_id=$1',[applicant.user]);
  await pool.query('insert into profiles(user_id,name,phone) values($1,$1,$2)',[applicant.user,phone]);
  const {encryptMerchantSensitiveData}=loadTypeScript('src/lib/security/merchant-sensitive.server.ts');
  await pool.query("insert into merchant_applications(id,user_id,business_name,category,catalog_categories,address,contact,registration_number,taxpayer_id_type,taxpayer_id_encrypted,business_type,tax_registration_status) values($1,$2,'Synthetic Multi Category','electronics',ARRAY['electronics','fashion'],'123 Synthetic Street',$3,$1,'other',$4,'other','not_applicable')",[app,applicant.user,phone,encryptMerchantSensitiveData('synthetic-tax-id')]);
  const decision={applicationId:app,action:'approve',reason:'Synthetic approval regression test',manualLocation:{latitude:5.6,longitude:-0.18,city:'Accra',neighborhood:'Test',justification:'Synthetic coordinates for integration test only'}};
  await assert.rejects(admin.call(admin.merchantReview.reviewMerchantApplication,decision),/email and phone verification/);
  await pool.query("update merchant_verification_checks set status='verified' where application_id=$1 and check_type='email'",[app]);
  // Synthetic provider proof fixture, not a real phone verification claim.
  await pool.query("insert into otp_challenges(id,user_id,destination,purpose,provider,status,verified_at,expires_at,cooldown_until) values($1,$2,$3,'phone_verification','arkesel','verified',now(),now()+interval '5 minutes',now())",[challenge,applicant.user,phone]);
  await pool.query('select confirm_phone_verification($1,$2)',[applicant.user,challenge]);
  const result=await admin.call(admin.merchantReview.reviewMerchantApplication,decision);activated=result.merchantId;
  assert.equal(result.activated,true);
  assert.deepEqual((await pool.query('select catalog_categories from merchants where id=$1',[activated])).rows[0].catalog_categories,['electronics','fashion']);
  assert.equal((await pool.query('select merchant_id from merchant_accounts where user_id=$1',[applicant.user])).rows[0].merchant_id,activated);
  assert.equal((await admin.call(admin.merchantReview.reviewMerchantApplication,decision)).activated,false,'Reapproval must not create another merchant');
 }finally{
  await pool.query('delete from merchant_applications where id=$1',[app]);
  await pool.query('delete from otp_challenges where id=$1',[challenge]);
  if(activated)await pool.query('delete from merchants where id=$1',[activated]);
  await applicant.cleanup();await admin.cleanup();await pool.query('delete from admin_roles where role_key=$1',[role]);
 }
});

test('provider approval creates scoped review-only adapters and preserves last owner',async()=>{
 const admin=await fixture(),applicant=await fixture();const role=await reviewer(admin);let applicationId,org;
 try{
  applicant.host(process.env.ELEMARKET_PROVIDER_HOST);
  ({applicationId}=await applicant.call(applicant.provider.submitProviderApplication,{organizationName:'Synthetic Provider',requestedCapabilities:['delivery','customer_financing','merchant_financing'],processingMode:'manual',serviceDescription:'Synthetic manual provider approval regression fixture'}));
  assert.equal((await applicant.call(applicant.provider.getProviderGatewayContext)).authorized,false);
  const result=await admin.call(admin.partnerAdmin.reviewProviderApplicationAdmin,{applicationId,action:'approve',adminNote:'Synthetic independently reviewed fixture'});org=result.organizationId;
  const access=await applicant.call(applicant.provider.getProviderGatewayContext);
  assert.equal(access.organizationId,org);assert.equal(access.role,'owner');assert.equal(access.capabilities.length,3);
  const funding=(await pool.query('select status,marketplace_enabled,customer_channel_enabled from financing_providers where partner_organization_id=$1',[org])).rows;
  assert.equal(funding.length,2);assert.ok(funding.every(p=>p.status==='review' && !p.marketplace_enabled && !p.customer_channel_enabled));
  assert.deepEqual((await pool.query('select status,environment from delivery_providers where partner_organization_id=$1',[org])).rows,[{status:'review',environment:'sandbox'}]);
  await assert.rejects(applicant.partnerAccess.requirePartnerAccess(applicant.user,'delivery',true),/beta|disabled/i);
  await assert.rejects(admin.call(admin.partnerAdmin.updatePartnerStaffAdmin,{organizationId:org,userId:applicant.user,role:'operator',status:'active',reason:'Synthetic last-owner regression attempt'}),/last active provider owner/);
  await assert.rejects(admin.call(admin.partnerAdmin.reviewProviderApplicationAdmin,{applicationId,action:'approve',adminNote:'Repeated fixture approval'}),/already finalized/);
 }finally{
  if(org){
   await pool.query('update partner_organizations set provider_gateway_application_id=null where id=$1',[org]);
   await pool.query('delete from financing_providers where partner_organization_id=$1',[org]);
   await pool.query('delete from delivery_providers where partner_organization_id=$1',[org]);
  }
  if(applicationId)await pool.query('delete from provider_gateway_applications where id=$1',[applicationId]);
  if(org)await pool.query('delete from partner_organizations where id=$1',[org]);
  await applicant.cleanup();await admin.cleanup();await pool.query('delete from admin_roles where role_key=$1',[role]);
 }
});


test('moderation timestamps satisfy string API contract for real PostgreSQL rows',async()=>{
 const admin=await fixture(),customer=await fixture();const role=await reviewer(admin);
 try{
  await pool.query("insert into admin_role_permissions(role_key,capability) values($1,'admin.operations')",[role]);
  const data=await admin.call(admin.moderation.loadAdminModeration);
  const product=data.products.find(p=>p.id===customer.product),user=data.customers.find(u=>u.id===customer.user);
  assert.ok(product);assert.ok(user);
  for(const row of [product,user]){assert.equal(typeof row.createdAt,'string');assert.match(row.createdAt,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);}
 }finally{await customer.cleanup();await admin.cleanup();await pool.query('delete from admin_roles where role_key=$1',[role]);}
});
