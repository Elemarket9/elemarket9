import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { getSql, withTransaction } from "@/lib/db";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const answerSchema=z.object({
  fieldId:z.string().min(1).max(128),
  answerText:z.string().max(4000).optional(),
  uploadIntentId:z.string().regex(/^upi_[A-Za-z0-9]+$/).optional(),
});
const submitSchema=z.object({
  providerId:z.string().min(1).max(128),
  quoteId:z.string().min(1).max(128),
  formId:z.string().min(1).max(128),
  answers:z.array(answerSchema).max(40),
  paymentMethod:z.enum(["mobile_money","card","bank_transfer"]).optional(),
  consentAccepted:z.literal(true),
  idempotencyKey:z.string().min(16).max(128),
});

function validateTextField(field:any,value:string|undefined){
  const v=(value??"").trim();
  if(field.required && !v)throw new Error(`${field.label} is required`);
  if(!v)return null;
  const max=field.maxLength??4000;
  if(v.length>max)throw new Error(`${field.label} is too long`);
  if(field.fieldType==="email"&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))throw new Error(`${field.label} must be a valid email`);
  if(field.fieldType==="phone"&&!/^\+?[0-9][0-9\s-]{5,30}$/.test(v))throw new Error(`${field.label} must be a valid phone number`);
  if(field.fieldType==="number"&&!Number.isFinite(Number(v)))throw new Error(`${field.label} must be a number`);
  if(field.fieldType==="checkbox"&&!["true","false"].includes(v))throw new Error(`${field.label} must be selected`);
  if(field.fieldType==="select"&&!Array.isArray(field.options)||field.fieldType==="select"&&!field.options.includes(v))throw new Error(`${field.label} contains an invalid option`);
  if(field.fieldType==="ghana_card_number"&&!/^GHA-\d{9}-\d$/i.test(v))throw new Error("Ghana Card number must use the format GHA-000000000-0");
  return field.fieldType==="ghana_card_number"?v.toUpperCase():v;
}

export const getCustomerFinancingProviderForm=createServerFn({method:"GET"})
  .middleware([authMiddleware])
  .validator(z.object({providerId:z.string().min(1).max(128),quoteId:z.string().min(1).max(128)}))
  .handler(async({data,context})=>{
    const userId=getAuthenticatedUserId(context);
    const { requireCustomerForUserId }=await import("@/modules/identity/public/auth/authorization.server");
    await requireCustomerForUserId(userId);
    await enforceRateLimit("customer-financing-provider-form",{windowSeconds:60,maxRequests:30,subject:userId});
    const sql=await getSql();
    const quote=await sql.query<{amount:number}>(`select amount::float8 as amount from customer_financing_quotes where id=$1 and user_id=$2 and used_at is null and expires_at>now() limit 1`,[data.quoteId,userId]);
    if(!quote[0])throw new Error("Financing quote expired");
    const forms=await sql.query<any>(`select f.id,f.title,f.description,f.version,f.deposit_type as "depositType",f.deposit_value::float8 as "depositValue",f.deposit_due_stage as "depositDueStage",
      p.minimum_initial_contribution_percent::float8 as "minimumInitialContributionPercent"
      from financing_provider_forms f join financing_providers p on p.id=f.provider_id
      where f.provider_id=$1 and f.status='active' and p.audience='customer' and p.status='active' and p.marketplace_enabled=true
        and p.marketplace_partner_status='active' and p.security_review_status in ('passed','waived') and p.integration_status='ready'
        and p.commercial_status='active' and p.customer_channel_enabled=true limit 1`,[data.providerId]);
    if(!forms[0])return {form:null,deposit:null};
    const form=forms[0];
    const fields=await sql.query<any>(`select id,field_key as "fieldKey",label,field_type as "fieldType",required,help_text as "helpText",options,max_length as "maxLength",sort_order as "sortOrder" from financing_provider_form_fields where form_id=$1 order by sort_order,id`,[form.id]);
    const q=Number(quote[0].amount);
    const configured=form.depositType==="fixed"?Number(form.depositValue??0):form.depositType==="percentage"?Number((q*Number(form.depositValue??0)/100).toFixed(2)):0;
    const providerMin=Number((q*Number(form.minimumInitialContributionPercent??0)/100).toFixed(2));
    const depositAmount=Math.max(configured,providerMin);
    const methods=depositAmount>0?await sql.query<{method:string}>(`select distinct pp.method from financing_provider_payment_accounts a join payment_providers pp on pp.provider_key=a.payment_provider_key and pp.status='active' where a.financing_provider_id=$1 and a.status='active' order by pp.method`,[data.providerId]):[];
    return {
      form:{id:form.id,title:form.title,description:form.description,version:form.version,fields},
      deposit:depositAmount>0?{amount:depositAmount,currency:"GHS",dueStage:form.depositDueStage,methods:methods.map(x=>x.method)}:null,
    };
  });

export const submitCustomerFinancingProviderApplication=createServerFn({method:"POST"})
  .middleware([authMiddleware])
  .validator(submitSchema)
  .handler(async({data,context})=>{
    const userId=getAuthenticatedUserId(context);
    const { requireCustomerForUserId }=await import("@/modules/identity/public/auth/authorization.server");
    await requireCustomerForUserId(userId);
    await enforceRateLimit("customer-financing-provider-submit",{windowSeconds:3600,maxRequests:5,subject:userId});

    const result=await withTransaction(async(sql)=>{
      const formRows=await sql.query<any>(`select f.id,f.version,f.deposit_type as "depositType",f.deposit_value::float8 as "depositValue",f.deposit_due_stage as "depositDueStage",
        p.minimum_initial_contribution_percent::float8 as "minimumInitialContributionPercent",p.partner_organization_id as "organizationId"
        from financing_provider_forms f join financing_providers p on p.id=f.provider_id
        where f.id=$1 and f.provider_id=$2 and f.status='active' and p.audience='customer'
          and p.status='active' and p.marketplace_enabled=true and p.marketplace_partner_status='active'
          and p.security_review_status in ('passed','waived') and p.integration_status='ready' and p.commercial_status='active'
          and p.customer_channel_enabled=true for share`,[data.formId,data.providerId]);
      if(formRows.length!==1)throw new Error("Provider financing form is no longer active");
      const form=formRows[0];
      const quote=await sql.query<{amount:number}>(`select amount::float8 as amount from customer_financing_quotes where id=$1 and user_id=$2 and used_at is null and expires_at>now() for update`,[data.quoteId,userId]);
      if(!quote[0])throw new Error("Financing quote expired");

      const fields=await sql.query<any>(`select id,field_key as "fieldKey",label,field_type as "fieldType",required,help_text as "helpText",options,max_length as "maxLength" from financing_provider_form_fields where form_id=$1 order by sort_order,id`,[form.id]);
      const provided=new Map(data.answers.map(a=>[a.fieldId,a]));
      if(data.answers.some(a=>!fields.some((f:any)=>f.id===a.fieldId)))throw new Error("Unknown provider financing form field");
      const normalized:Array<{field:any;text:string|null;upload:any|null}>=[];
      for(const field of fields){
        const answer=provided.get(field.id);
        const isFile=["ghana_card_front","ghana_card_back","selfie","document"].includes(field.fieldType);
        if(isFile){
          if(field.required&&!answer?.uploadIntentId)throw new Error(`${field.label} is required`);
          if(answer?.answerText)throw new Error(`${field.label} must be uploaded as a file`);
          let upload=null;
          if(answer?.uploadIntentId){
            const rows=await sql.query<any>(`select id,object_key,content_type from storage_upload_intents where id=$1 and user_id=$2 and purpose='financing-application-document' and resource_id=$3 and status='verified' limit 1 for share`,[answer.uploadIntentId,userId,data.quoteId]);
            if(rows.length!==1)throw new Error(`${field.label} upload is not verified`);
            upload=rows[0];
          }
          normalized.push({field,text:null,upload});
        }else{
          if(answer?.uploadIntentId)throw new Error(`${field.label} does not accept a file`);
          normalized.push({field,text:validateTextField(field,answer?.answerText),upload:null});
        }
      }

      const amount=Number(quote[0].amount);
      const configured=form.depositType==="fixed"?Number(form.depositValue??0):form.depositType==="percentage"?Number((amount*Number(form.depositValue??0)/100).toFixed(2)):0;
      const providerMin=Number((amount*Number(form.minimumInitialContributionPercent??0)/100).toFixed(2));
      const depositAmount=Math.max(configured,providerMin);
      if(depositAmount>0&&!data.paymentMethod)throw new Error("Select a payment method for the provider initial deposit");

      const rows=await sql.query<{result:any}>(`select start_customer_financing_application($1,$2,$3,$4,$5,$6) as result`,
        [userId,data.providerId,data.quoteId,null,depositAmount>0?depositAmount:null,data.idempotencyKey]);
      const started=rows[0]?.result;
      if(!started?.applicationId)throw new Error("Financing application could not be started");

      const existing=await sql.query<{id:string}>(`select id from financing_application_form_submissions where application_id=$1 limit 1`,[started.applicationId]);
      if(!existing.length){
        const submissionId=`ffsub_${crypto.randomUUID().replaceAll("-","")}`;
        await sql.query(`insert into financing_application_form_submissions(id,application_id,provider_id,form_id,form_version,submitted_by_user_id) values($1,$2,$3,$4,$5,$6)`,
          [submissionId,started.applicationId,data.providerId,form.id,form.version,userId]);
        const { encryptFinancingSensitiveData }=await import("@/lib/security/financing-sensitive.server");
        for(const n of normalized){
          await sql.query(`insert into financing_application_form_answers(id,submission_id,field_id,field_key,field_type,answer_text,upload_intent_id,storage_reference,content_type) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [`ffans_${crypto.randomUUID().replaceAll("-","")}`,submissionId,n.field.id,n.field.fieldKey,n.field.fieldType,n.text===null?null:encryptFinancingSensitiveData(n.text),n.upload?.id??null,n.upload?.object_key??null,n.upload?.content_type??null]);
        }
        const consentPayload=`${userId}:${data.providerId}:${started.applicationId}:${form.id}:${form.version}:provider_data_sharing`;
        const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(consentPayload));
        const evidenceHash=Array.from(new Uint8Array(digest),(b)=>b.toString(16).padStart(2,"0")).join("");
        await sql.query(`insert into financing_marketplace_consents(id,organization_id,provider_id,application_audience,application_id,subject_user_id,purpose,consent_version,consent_method,consented_at,evidence_hash,metadata)
          values($1,$2,$3,'customer',$4,$5,'provider_data_sharing',$6,'electronic',now(),$7,$8::jsonb)
          on conflict(provider_id,application_audience,application_id,purpose,consent_version) do nothing`,
          [`fmc_${crypto.randomUUID().replaceAll("-","")}`,form.organizationId,data.providerId,started.applicationId,userId,`provider-form:${form.id}:v${form.version}`,evidenceHash,JSON.stringify({formId:form.id,formVersion:form.version})]);
        await sql.query(`update customer_financing_applications set provider_form_id=$2,provider_form_version=$3,initial_deposit_status=$4,updated_at=now() where id=$1`,
          [started.applicationId,form.id,form.version,depositAmount>0?"pending":"not_required"]);
      }

      let depositPaymentId:null|string=null;
      if(depositAmount>0 && form.depositDueStage==="on_application"){
        const d=await sql.query<{id:string}>(`select id from financing_deposit_payments where application_id=$1 limit 1`,[started.applicationId]);
        if(d[0])depositPaymentId=d[0].id;
        else{
          const accounts=await sql.query<any>(`select a.payment_provider_key,a.provider_account_ref from financing_provider_payment_accounts a join payment_providers pp on pp.provider_key=a.payment_provider_key and pp.status='active' where a.financing_provider_id=$1 and a.status='active' and pp.method=$2 order by a.payment_provider_key limit 1`,[data.providerId,data.paymentMethod]);
          if(accounts.length!==1)throw new Error("Selected initial-deposit payment method is unavailable");
          depositPaymentId=`fdp_${crypto.randomUUID().replaceAll("-","")}`;
          await sql.query(`insert into financing_deposit_payments(id,application_id,user_id,financing_provider_id,payment_provider_key,provider_account_ref,amount,currency,method,status) values($1,$2,$3,$4,$5,$6,$7,'GHS',$8,'initiated')`,
            [depositPaymentId,started.applicationId,userId,data.providerId,accounts[0].payment_provider_key,accounts[0].provider_account_ref,depositAmount,data.paymentMethod]);
        }
      }
      return {started,depositAmount,depositPaymentId,depositDueStage:form.depositDueStage};
    });

    let depositPayment:any=null;
    if(result.depositPaymentId){
      try{
        const { createFinancingDepositExternalIntent }=await import("@/modules/financing/internal/financing-deposit.server");
        depositPayment=await createFinancingDepositExternalIntent({depositPaymentId:result.depositPaymentId,userId});
      }catch{
        depositPayment={depositPaymentId:result.depositPaymentId,status:"initialization_pending",checkoutUrl:null};
      }
    }
    return {
      applicationId:result.started.applicationId,
      status:result.started.status,
      providerApprovalRequired:true,
      initialDepositAmount:result.depositAmount,
      initialDepositDueStage:result.depositDueStage,
      depositPayment,
    };
  });

export const getCustomerFinancingDepositStatus=createServerFn({method:"GET"})
  .middleware([authMiddleware])
  .validator(z.object({depositPaymentId:z.string().min(1).max(128)}))
  .handler(async({data,context})=>{
    const userId=getAuthenticatedUserId(context);const sql=await getSql();
    const rows=await sql.query<any>(`select id,application_id as "applicationId",amount::float8 as amount,currency,status,provider_reference as "providerReference" from financing_deposit_payments where id=$1 and user_id=$2 limit 1`,[data.depositPaymentId,userId]);
    if(!rows[0])throw new Error("Financing deposit payment not found");
    return rows[0];
  });


export const completePreviewFinancingDeposit=createServerFn({method:"POST"})
  .middleware([authMiddleware])
  .validator(z.object({depositPaymentId:z.string().min(1).max(128)}))
  .handler(async({data,context})=>{
    const userId=getAuthenticatedUserId(context);
    const { requireCustomerForUserId }=await import("@/modules/identity/public/auth/authorization.server");
    await requireCustomerForUserId(userId);
    const { completePreviewFinancingDepositServer }=await import("@/modules/financing/internal/financing-deposit.server");
    return completePreviewFinancingDepositServer({depositPaymentId:data.depositPaymentId,userId});
  });


export const retryCustomerFinancingDeposit=createServerFn({method:"POST"})
  .middleware([authMiddleware])
  .validator(z.object({depositPaymentId:z.string().min(1).max(128)}))
  .handler(async({data,context})=>{
    const userId=getAuthenticatedUserId(context);
    const { requireCustomerForUserId }=await import("@/modules/identity/public/auth/authorization.server");
    await requireCustomerForUserId(userId);
    await enforceRateLimit("customer-financing-deposit-retry",{windowSeconds:300,maxRequests:3,subject:userId});
    const { retryFinancingDepositPaymentServer }=await import("@/modules/financing/internal/financing-deposit.server");
    return retryFinancingDepositPaymentServer({depositPaymentId:data.depositPaymentId,userId});
  });


export const resumeCustomerFinancingDeposit=createServerFn({method:"POST"})
  .middleware([authMiddleware])
  .validator(z.object({depositPaymentId:z.string().min(1).max(128)}))
  .handler(async({data,context})=>{
    const userId=getAuthenticatedUserId(context);
    const { requireCustomerForUserId }=await import("@/modules/identity/public/auth/authorization.server");
    await requireCustomerForUserId(userId);
    await enforceRateLimit("customer-financing-deposit-resume",{windowSeconds:60,maxRequests:5,subject:userId});
    const { createFinancingDepositExternalIntent }=await import("@/modules/financing/internal/financing-deposit.server");
    return createFinancingDepositExternalIntent({depositPaymentId:data.depositPaymentId,userId});
  });
