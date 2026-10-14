import type { JsonObject } from "@/lib/db-types";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { getSql, withTransaction } from "@/lib/db";
import { requirePartnerAdmin, requirePartnerAccess } from "@/lib/partner/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const fieldType=z.enum(["text","textarea","email","phone","number","select","checkbox","ghana_card_number","ghana_card_front","ghana_card_back","selfie","document"]);
const hasAtMostTwoDecimals=(v:number)=>Math.abs(v*100-Math.round(v*100))<1e-8;
const fieldSchema=z.object({
  fieldKey:z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/),
  label:z.string().trim().min(2).max(160),
  fieldType,
  required:z.boolean(),
  helpText:z.string().trim().max(500).optional(),
  options:z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  maxLength:z.number().int().min(1).max(4000).optional(),
  sortOrder:z.number().int().min(0).max(1000),
}).superRefine((v,c)=>{
  if(v.fieldType==="select" && v.options.length<1)c.addIssue({code:"custom",message:"Select fields require options",path:["options"]});
  if(v.fieldType!=="select" && v.options.length)c.addIssue({code:"custom",message:"Options are valid only for select fields",path:["options"]});
});
const formSchema=z.object({
  providerId:z.string().trim().min(1).max(128),
  title:z.string().trim().min(2).max(160),
  description:z.string().trim().max(1500).optional(),
  depositType:z.enum(["none","fixed","percentage"]),
  depositValue:z.number().finite().nonnegative().max(100_000_000).refine(hasAtMostTwoDecimals,"Deposit value must have at most two decimal places").optional(),
  depositDueStage:z.enum(["on_application","after_approval"]).default("on_application"),
  fields:z.array(fieldSchema).min(1).max(40).superRefine((fields,c)=>{
    const keys=new Set<string>();
    fields.forEach((f,i)=>{if(keys.has(f.fieldKey))c.addIssue({code:"custom",message:"Duplicate field key",path:[i,"fieldKey"]});keys.add(f.fieldKey)});
  }),
}).superRefine((v,c)=>{
  if(v.depositType==="none" && (v.depositValue??0)!==0)c.addIssue({code:"custom",message:"No-deposit form cannot define a deposit value",path:["depositValue"]});
  if(v.depositType==="fixed" && !(Number(v.depositValue)>0))c.addIssue({code:"custom",message:"Fixed deposit amount required",path:["depositValue"]});
  if(v.depositType==="percentage" && !(Number(v.depositValue)>0 && Number(v.depositValue)<100))c.addIssue({code:"custom",message:"Deposit percentage must be between 0 and 100",path:["depositValue"]});
});

async function requireOwnedProvider(userId:string,providerId:string,admin=false){
  const access=admin?await requirePartnerAdmin(userId,"customer_financing"):await requirePartnerAccess(userId,"customer_financing");
  const sql=await getSql();
  const rows=await sql.query<{id:string}>(`select id from financing_providers where id=$1 and partner_organization_id=$2 and audience='customer' limit 1`,[providerId,access.organizationId]);
  if(rows.length!==1)throw new Error("Customer financing provider not found for this organization");
  return access;
}

export const loadProviderFinancingForms=createServerFn({method:"GET"}).middleware([authMiddleware]).handler(async({context})=>{
  const userId=getAuthenticatedUserId(context);
  const access=await requirePartnerAccess(userId,"customer_financing");
  const sql=await getSql();
  const providers=await sql.query<JsonObject>(`select id,name,status,integration_mode as "integrationMode" from financing_providers where partner_organization_id=$1 and audience='customer' order by name`,[access.organizationId]);
  const forms=await sql.query<JsonObject>(`select f.id,f.provider_id as "providerId",f.title,f.description,f.version,f.status,f.deposit_type as "depositType",f.deposit_value::float8 as "depositValue",f.deposit_due_stage as "depositDueStage",f.updated_at::text as "updatedAt",
    coalesce(jsonb_agg(jsonb_build_object('id',ff.id,'fieldKey',ff.field_key,'label',ff.label,'fieldType',ff.field_type,'required',ff.required,'helpText',ff.help_text,'options',ff.options,'maxLength',ff.max_length,'sortOrder',ff.sort_order) order by ff.sort_order,ff.id) filter(where ff.id is not null),'[]'::jsonb) as fields
    from financing_provider_forms f
    join financing_providers p on p.id=f.provider_id and p.partner_organization_id=$1
    left join financing_provider_form_fields ff on ff.form_id=f.id
    group by f.id order by f.updated_at desc`,[access.organizationId]);
  const paymentAccounts=await sql.query<JsonObject>(`select a.financing_provider_id as "providerId",a.payment_provider_key as "paymentProviderKey",pp.method,a.provider_account_ref as "providerAccountRef",a.status
    from financing_provider_payment_accounts a join financing_providers fp on fp.id=a.financing_provider_id and fp.partner_organization_id=$1
    join payment_providers pp on pp.provider_key=a.payment_provider_key
    order by fp.name,pp.method,pp.provider_key`,[access.organizationId]);
  const availablePaymentProviders=await sql.query<JsonObject>(`select provider_key as "providerKey",method,status from payment_providers where status='active' order by method,provider_key`);
  return {organization:access.organizationName,role:access.role,providers,forms,paymentAccounts,availablePaymentProviders};
});

export const saveProviderFinancingForm=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(formSchema).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context);
  const access=await requireOwnedProvider(userId,data.providerId,true);
  await enforceRateLimit("provider-financing-form-save",{windowSeconds:3600,maxRequests:30,subject:`${access.organizationId}:${userId}`});
  return withTransaction(async(sql)=>{
    await sql.query(`select id from financing_providers where id=$1 and partner_organization_id=$2 for update`,[data.providerId,access.organizationId]);
    const draft=await sql.query<{id:string;version:number}>(`select id,version from financing_provider_forms where provider_id=$1 and status='draft' order by updated_at desc limit 1 for update`,[data.providerId]);
    let formId=draft[0]?.id;
    let version=draft[0]?.version;
    if(!formId){
      const active=await sql.query<{version:number}>(`select version from financing_provider_forms where provider_id=$1 and status='active' order by published_at desc limit 1 for share`,[data.providerId]);
      version=(active[0]?.version??0)+1;
      formId=`fff_${crypto.randomUUID().replaceAll("-","")}`;
      await sql.query(`insert into financing_provider_forms(id,provider_id,title,description,version,status,deposit_type,deposit_value,deposit_due_stage,created_by_user_id) values($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9)`,[formId,data.providerId,data.title,data.description??null,version,data.depositType,data.depositType==="none"?null:data.depositValue??null,data.depositDueStage,userId]);
    }else{
      await sql.query(`update financing_provider_forms set title=$2,description=$3,deposit_type=$4,deposit_value=$5,deposit_due_stage=$6,updated_at=now() where id=$1`,[formId,data.title,data.description??null,data.depositType,data.depositType==="none"?null:data.depositValue??null,data.depositDueStage]);
      await sql.query(`delete from financing_provider_form_fields where form_id=$1`,[formId]);
    }
    for(const f of data.fields){
      await sql.query(`insert into financing_provider_form_fields(id,form_id,field_key,label,field_type,required,help_text,options,max_length,sort_order) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,[`fffld_${crypto.randomUUID().replaceAll("-","")}`,formId,f.fieldKey,f.label,f.fieldType,f.required,f.helpText??null,JSON.stringify(f.options),f.maxLength??null,f.sortOrder]);
    }
    await sql.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'financing.form.saved','financing_provider_form',$3,'success',$4::jsonb)`,[access.organizationId,userId,formId,JSON.stringify({providerId:data.providerId,version,fieldCount:data.fields.length,depositType:data.depositType,depositValue:data.depositValue??null})]);
    return {formId,version,status:"draft"};
  });
});

export const publishProviderFinancingForm=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({formId:z.string().min(1).max(128)})).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context);
  const access=await requirePartnerAdmin(userId,"customer_financing");
  return withTransaction(async(sql)=>{
    const rows=await sql.query<{id:string;providerId:string;depositType:string;depositValue:number|null}>(`select f.id,f.provider_id as "providerId",f.deposit_type as "depositType",f.deposit_value::float8 as "depositValue" from financing_provider_forms f join financing_providers p on p.id=f.provider_id and p.partner_organization_id=$2 where f.id=$1 and f.status='draft' for update`,[data.formId,access.organizationId]);
    if(rows.length!==1)throw new Error("Draft financing form not found");
    const count=await sql.query<{count:number}>(`select count(*)::int as count from financing_provider_form_fields where form_id=$1`,[data.formId]);
    if((count[0]?.count??0)<1)throw new Error("Financing form requires at least one field");
    if(rows[0].depositType!=="none"){
      const accounts=await sql.query(`select 1 from financing_provider_payment_accounts a join payment_providers pp on pp.provider_key=a.payment_provider_key and pp.status='active' where a.financing_provider_id=$1 and a.status='active' limit 1`,[rows[0].providerId]);
      if(!accounts.length)throw new Error("Configure at least one active direct deposit payment account before publishing a deposit form");
    }
    await sql.query(`update financing_provider_forms set status='archived',updated_at=now() where provider_id=$1 and status='active'`,[rows[0].providerId]);
    await sql.query(`update financing_provider_forms set status='active',published_by_user_id=$2,published_at=now(),updated_at=now() where id=$1`,[data.formId,userId]);
    await sql.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'financing.form.published','financing_provider_form',$3,'success','{}'::jsonb)`,[access.organizationId,userId,data.formId]);
    return {published:true};
  });
});

export const saveFinancingDepositPaymentAccount=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({
  financingProviderId:z.string().min(1).max(128),
  paymentProviderKey:z.string().min(2).max(128),
  providerAccountRef:z.string().trim().min(2).max(256),
  status:z.enum(["active","suspended","disabled"]).default("active"),
})).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context);
  const access=await requireOwnedProvider(userId,data.financingProviderId,true);
  const sql=await getSql();
  const pp=await sql.query(`select 1 from payment_providers where provider_key=$1 and status='active' limit 1`,[data.paymentProviderKey]);
  if(!pp.length)throw new Error("Payment provider is not active");
  await sql.query(`insert into financing_provider_payment_accounts(financing_provider_id,payment_provider_key,provider_account_ref,status,created_by_user_id,updated_at) values($1,$2,$3,$4,$5,now())
    on conflict(financing_provider_id,payment_provider_key) do update set provider_account_ref=excluded.provider_account_ref,status=excluded.status,updated_at=now()`,[data.financingProviderId,data.paymentProviderKey,data.providerAccountRef,data.status,userId]);
  await sql.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'financing.deposit_account.saved','financing_provider',$3,'success',$4::jsonb)`,[access.organizationId,userId,data.financingProviderId,JSON.stringify({paymentProviderKey:data.paymentProviderKey,status:data.status})]);
  return {saved:true};
});
