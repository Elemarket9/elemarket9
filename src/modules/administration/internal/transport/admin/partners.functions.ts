import type { JsonObject } from "@/lib/db-types";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware,getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { getSql, withTransaction, type Sql } from "@/lib/db";

const capability=z.enum(["delivery","customer_financing","merchant_financing"]);
const orgSchema=z.object({id:z.string().trim().min(2).max(128),name:z.string().trim().min(2).max(160),status:z.enum(["review","active","suspended","inactive"]),contactEmail:z.string().email().max(254).optional(),capabilities:z.array(capability).min(1).max(3),reason:z.string().trim().min(12).max(1000)});
const applicationDecisionSchema=z.object({applicationId:z.string().min(1).max(128),action:z.enum(["approve","request_information","reject"]),adminNote:z.string().trim().min(12).max(2000)});
const staffSchema=z.object({organizationId:z.string().min(1).max(128),email:z.string().email().max(254),role:z.enum(["owner","admin","operator","analyst"]),reason:z.string().trim().min(12).max(1000)});
const staffStatusSchema=z.object({organizationId:z.string().min(1).max(128),userId:z.string().min(1).max(128),status:z.enum(["active","suspended"]),role:z.enum(["owner","admin","operator","analyst"]),reason:z.string().trim().min(12).max(1000)});
const deliveryProviderSchema=z.object({id:z.string().min(1).max(128),status:z.enum(["review","active","suspended","inactive"]),integrationMode:z.enum(["api","manual","partner_handoff"]),environment:z.enum(["sandbox","production"]),reason:z.string().trim().min(12).max(1000)});

async function adminGuard(userId:string,rateKey:string){
 await requireAdminForUserId(userId, "admin.providers.manage");await requireFreshSession();
 await enforceRateLimit(rateKey,{windowSeconds:3600,maxRequests:60,subject:userId});
}

export const loadPartnerOrganizationsAdmin=createServerFn({method:"GET"}).middleware([authMiddleware]).handler(async({context})=>{
 const userId=getAuthenticatedUserId(context);await requireAdminForUserId(userId, "admin.providers.manage");const sql=await getSql();
 const organizations=await sql.query<JsonObject>(`select o.id,o.name,o.status,o.contact_email as "contactEmail",o.preferred_processing_mode as "processingMode",o.created_at::text as "createdAt",coalesce(array_agg(c.capability) filter(where c.capability is not null),'{}') as capabilities from partner_organizations o left join partner_organization_capabilities c on c.organization_id=o.id group by o.id order by o.created_at desc`);
 const applications=await sql.query<JsonObject>(`select id,applicant_user_id as "applicantUserId",organization_name as "organizationName",contact_email as "contactEmail",contact_phone as "contactPhone",website_url as "websiteUrl",requested_capabilities as "requestedCapabilities",processing_mode as "processingMode",service_description as "serviceDescription",status,admin_note as "adminNote",created_at::text as "createdAt" from provider_gateway_applications order by case when status in ('review','information_requested') then 0 else 1 end,created_at desc limit 250`);
 const staff=await sql.query<JsonObject>(`select pu.organization_id as "organizationId",pu.user_id as "userId",u.email,u.name,pu.role,pu.status,pu.created_at::text as "createdAt" from partner_organization_users pu join "user" u on u.id=pu.user_id order by pu.organization_id,pu.created_at`);
 const deliveryProviders=await sql.query<JsonObject>(`select d.id,d.name,d.partner_organization_id as "organizationId",d.status,d.integration_mode as "integrationMode",d.environment from delivery_providers d order by d.name`);
 return {organizations,applications,staff,deliveryProviders};
});

export const savePartnerOrganizationAdmin=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(orgSchema).handler(async({data,context})=>{
 const userId=getAuthenticatedUserId(context);await adminGuard(userId,"admin-partner-save");
 return withTransaction(async(sql)=>{
  await sql.query(`select id from partner_organizations where id=$1 for update`,[data.id]);
  await sql.query(`insert into partner_organizations(id,name,status,contact_email,approved_at,approved_by_user_id,updated_at) values($1,$2,$3,$4,case when $3='active' then now() else null end,case when $3='active' then $5 else null end,now()) on conflict(id) do update set name=excluded.name,status=excluded.status,contact_email=excluded.contact_email,approved_at=case when excluded.status='active' then coalesce(partner_organizations.approved_at,now()) else partner_organizations.approved_at end,approved_by_user_id=case when excluded.status='active' then coalesce(partner_organizations.approved_by_user_id,$5) else partner_organizations.approved_by_user_id end,updated_at=now()`,[data.id,data.name,data.status,data.contactEmail??null,userId]);
  await sql.query(`delete from partner_organization_capabilities where organization_id=$1`,[data.id]);
  for(const c of data.capabilities) await sql.query(`insert into partner_organization_capabilities(organization_id,capability) values($1,$2)`,[data.id,c]);
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,["admin.partner.saved","partner_organization",data.id,userId,"admin",null,"success",JSON.stringify({status:data.status,capabilities:data.capabilities,reason:data.reason})]);
  return {saved:true};
 });
});

export const reviewProviderApplicationAdmin=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(applicationDecisionSchema).handler(async({data,context})=>{
 const adminId=getAuthenticatedUserId(context);await adminGuard(adminId,"admin-provider-application-review");
 return withTransaction(async(sql)=>{
  const rows=await sql.query<any>(`select * from provider_gateway_applications where id=$1 for update`,[data.applicationId]);
  if(rows.length!==1) throw new Error("Provider application not found");
  const a=rows[0];
  if(!["review","information_requested"].includes(a.status)) throw new Error("Provider application is already finalized");
  if(data.action==="request_information"){
   await sql.query(`update provider_gateway_applications set status='information_requested',admin_note=$2,reviewed_by_user_id=$3,reviewed_at=now(),updated_at=now() where id=$1`,[a.id,data.adminNote,adminId]);
   await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,["admin.provider_application.information_requested","provider_gateway_application",a.id,adminId,"admin",null,"success",JSON.stringify({reason:data.adminNote})]);
   return {status:"information_requested"};
  }
  if(data.action==="reject"){
   await sql.query(`update provider_gateway_applications set status='rejected',admin_note=$2,reviewed_by_user_id=$3,reviewed_at=now(),updated_at=now() where id=$1`,[a.id,data.adminNote??null,adminId]);
   await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,["admin.provider_application.rejected","provider_gateway_application",a.id,adminId,"admin",null,"success",JSON.stringify({reason:data.adminNote})]);
   return {status:"rejected"};
  }

  const orgId=`por_${crypto.randomUUID().replaceAll("-","")}`;
  await sql.query(`insert into partner_organizations(id,name,status,contact_email,approved_at,approved_by_user_id,provider_gateway_application_id,preferred_processing_mode,updated_at) values($1,$2,'active',$3,now(),$4,$5,$6,now())`,[orgId,a.organization_name,a.contact_email,adminId,a.id,a.processing_mode]);
  for(const c of a.requested_capabilities as string[]) await sql.query(`insert into partner_organization_capabilities(organization_id,capability) values($1,$2)`,[orgId,c]);
  await sql.query(`insert into partner_organization_users(organization_id,user_id,role,status) values($1,$2,'owner','active')`,[orgId,a.applicant_user_id]);

  const manualFinancing=a.processing_mode==="api"?"api":"manual_review";
  const deliveryMode=a.processing_mode==="api"?"api":"manual";
  if((a.requested_capabilities as string[]).includes("customer_financing")){
   const id=`fp_${crypto.randomUUID().replaceAll("-","")}`;
   await sql.query(`insert into financing_providers(id,provider_key,name,provider_legal_name,audience,product_type,status,partner_organization_id,integration_mode,manual_operations_enabled,marketplace_enabled,marketplace_partner_status,security_review_status,integration_status,commercial_status,customer_channel_enabled) values($1,$2,$3,$3,'customer','installment','review',$4,$5,true,false,'review','pending','pending','pending',false)`,[id,`${orgId}_customer`,a.organization_name,orgId,manualFinancing]);
  }
  if((a.requested_capabilities as string[]).includes("merchant_financing")){
   const id=`fp_${crypto.randomUUID().replaceAll("-","")}`;
   await sql.query(`insert into financing_providers(id,provider_key,name,provider_legal_name,audience,product_type,status,partner_organization_id,integration_mode,manual_operations_enabled,marketplace_enabled,marketplace_partner_status,security_review_status,integration_status,commercial_status,customer_channel_enabled) values($1,$2,$3,$3,'merchant','term_loan','review',$4,$5,true,false,'review','pending','pending','pending',false)`,[id,`${orgId}_merchant`,a.organization_name,orgId,manualFinancing]);
  }
  if((a.requested_capabilities as string[]).includes("delivery")){
   const id=`dp_${crypto.randomUUID().replaceAll("-","")}`;
   await sql.query(`insert into delivery_providers(id,provider_key,name,partner_organization_id,status,integration_mode,environment) values($1,$2,$3,$4,'review',$5,'sandbox')`,[id,`${orgId}_delivery`,a.organization_name,orgId,deliveryMode]);
  }
  await sql.query(`update provider_gateway_applications set status='approved',organization_id=$2,admin_note=$3,reviewed_by_user_id=$4,reviewed_at=now(),updated_at=now() where id=$1`,[a.id,orgId,data.adminNote??null,adminId]);
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,["admin.provider_application.approved","partner_organization",orgId,adminId,"admin",null,"success",JSON.stringify({applicationId:a.id,capabilities:a.requested_capabilities,processingMode:a.processing_mode,reason:data.adminNote})]);
  return {status:"approved",organizationId:orgId};
 });
});

async function assertPartnerOwnerRetained(sql: Sql, organizationId: string, userId: string, role: string, status: string) {
  const target = await sql.query<{role:string;status:string}>(
    `select role,status from partner_organization_users where organization_id=$1 and user_id=$2 for update`, [organizationId,userId]);
  if (target[0]?.role === "owner" && target[0].status === "active" && (role !== "owner" || status !== "active")) {
    const others = await sql.query(`select 1 from partner_organization_users where organization_id=$1 and user_id<>$2 and role='owner' and status='active' limit 1`, [organizationId,userId]);
    if (!others.length) throw new Error("Cannot remove the last active provider owner");
  }
  return target[0];
}

export const addPartnerStaffAdmin=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(staffSchema).handler(async({data,context})=>{
 const adminId=getAuthenticatedUserId(context);await adminGuard(adminId,"admin-partner-staff-add");
 return withTransaction(async(sql)=>{
  const org=await sql.query<{id:string}>(`select id from partner_organizations where id=$1 and status='active' for update`,[data.organizationId]);
  if(org.length!==1) throw new Error("Active provider organization not found");
  const users=await sql.query<{id:string}>(
    `select id from "user" where lower(email)=lower($1) and "emailVerified"=true limit 1`,
    [data.email]);
  if(users.length!==1) throw new Error("Provider staff account must exist and have a verified email before organization access is granted");
  await assertPartnerOwnerRetained(sql,data.organizationId,users[0].id,data.role,"active");
  await sql.query(`insert into partner_organization_users(organization_id,user_id,role,status) values($1,$2,$3,'active') on conflict(organization_id,user_id) do update set role=excluded.role,status='active'`,[data.organizationId,users[0].id,data.role]);
  await sql.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'partner.staff.admin_added','partner_user',$3,'success',$4::jsonb)`,[data.organizationId,adminId,users[0].id,JSON.stringify({role:data.role,reason:data.reason})]);
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
    "admin.partner_staff.access_changed", "partner_staff", users[0].id, adminId, "admin", null, "success",
    JSON.stringify({organizationId:data.organizationId,role:data.role,reason:data.reason}),
  ]);
  return {saved:true};
 });
});

export const updatePartnerStaffAdmin=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(staffStatusSchema).handler(async({data,context})=>{
 const adminId=getAuthenticatedUserId(context);await adminGuard(adminId,"admin-partner-staff-update");
 return withTransaction(async(sql)=>{
  // Serialize changes across different memberships before checking the owner count.
  const org=await sql.query(`select id from partner_organizations where id=$1 for update`,[data.organizationId]);
  if(!org.length) throw new Error("Provider organization not found");
  const target=await assertPartnerOwnerRetained(sql,data.organizationId,data.userId,data.role,data.status);
  if(!target) throw new Error("Provider staff membership not found");
  await sql.query(`update partner_organization_users set role=$3,status=$4 where organization_id=$1 and user_id=$2`,[data.organizationId,data.userId,data.role,data.status]);
  await sql.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'partner.staff.admin_updated','partner_user',$3,'success',$4::jsonb)`,[data.organizationId,adminId,data.userId,JSON.stringify({role:data.role,status:data.status,reason:data.reason})]);
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
    "admin.partner_staff.access_changed", "partner_staff", data.userId, adminId, "admin", null, "success",
    JSON.stringify({organizationId:data.organizationId,role:data.role,status:data.status,reason:data.reason}),
  ]);
  return {saved:true};
 });
});


export const saveDeliveryProviderAdmin=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(deliveryProviderSchema).handler(async({data,context})=>{
 const adminId=getAuthenticatedUserId(context);await adminGuard(adminId,"admin-delivery-provider-save");
 return withTransaction(async(sql)=>{
  const rows=await sql.query<{organizationId:string}>(`select partner_organization_id as "organizationId" from delivery_providers where id=$1 for update`,[data.id]);
  if(rows.length!==1) throw new Error("Delivery provider not found");
  await sql.query(`update delivery_providers set status=$2,integration_mode=$3,environment=$4,updated_at=now() where id=$1`,[data.id,data.status,data.integrationMode,data.environment]);
  if(rows[0].organizationId) await sql.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'delivery.provider.admin_updated','delivery_provider',$3,'success',$4::jsonb)`,[rows[0].organizationId,adminId,data.id,JSON.stringify({status:data.status,integrationMode:data.integrationMode,environment:data.environment,reason:data.reason})]);
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
    "admin.delivery_provider.status_changed", "delivery_provider", data.id, adminId, "admin", null, "success",
    JSON.stringify({status:data.status,integrationMode:data.integrationMode,environment:data.environment,reason:data.reason}),
  ]);
  return {saved:true};
 });
});
