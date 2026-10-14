import { assertCommerceExecutionAllowed } from "@/lib/security/launch-profile.mjs";
import { getSql, withTransaction } from "@/lib/db";
import { getPaymentAdapter } from "@/modules/payments/public/adapters/registry";
import { normalizeProviderKey } from "@/modules/payments/public/provider-policy.server";
import { env, getElemarketEnvironment } from "@/lib/env.server";

function validateCheckoutUrl(value:string|undefined,providerKey:string):string|undefined{
  if(!value)return undefined;
  if(value.startsWith("/")){
    if(getElemarketEnvironment()==="development"||getElemarketEnvironment()==="preview")return value;
    throw new Error("Payment provider checkout URL must be absolute HTTPS");
  }
  const url=new URL(value);
  if(url.protocol!=="https:"||url.username||url.password||url.hash||(url.port&&url.port!=="443"))throw new Error("Unsafe payment provider checkout URL");
  const envKey=`ELEMARKET_PAYMENT_${providerKey.toUpperCase().replace(/[^A-Z0-9]+/g,"_")}_CHECKOUT_HOSTS`;
  const hosts=(env(envKey)??"").split(",").map(v=>v.trim().toLowerCase()).filter(Boolean);
  if(!hosts.includes(url.hostname.toLowerCase()))throw new Error("Payment provider checkout host is not approved");
  return url.toString();
}

export async function createFinancingDepositExternalIntent(input:{depositPaymentId:string;userId:string}){
  assertCommerceExecutionAllowed("createFinancingDepositExternalIntent");
  const prepared=await withTransaction(async(sql)=>{
    await sql.query(`select pg_advisory_xact_lock(hashtext($1))`,[`elemarket:financing-deposit:${input.depositPaymentId}`]);
    const rows=await sql.query<any>(`select d.id,d.application_id,d.user_id,d.financing_provider_id,d.payment_provider_key,d.provider_account_ref,d.amount::text as amount,d.currency,d.method,d.status,u.email
      from financing_deposit_payments d join "user" u on u.id=d.user_id
      where d.id=$1 and d.user_id=$2 limit 1 for update of d`,[input.depositPaymentId,input.userId]);
    if(rows.length!==1)throw new Error("Financing deposit payment not found");
    const d=rows[0];
    if(d.status==="completed")return {done:true as const,result:{depositPaymentId:d.id,status:"completed",checkoutUrl:null,existing:true}};
    if(d.status!=="initiated"&&d.status!=="authorized")throw new Error("Financing deposit payment is not startable");
    const providerKey=normalizeProviderKey(d.payment_provider_key);
    const providers=await sql.query<any>(`select provider_key,driver_key from payment_providers where provider_key=$1 and method=$2 and status='active'`,[providerKey,d.method]);
    if(!providers[0])throw new Error("Payment provider is unavailable for financing deposit");
    const account=await sql.query(`select 1 from financing_provider_payment_accounts where financing_provider_id=$1 and payment_provider_key=$2 and provider_account_ref=$3 and status='active'`,[d.financing_provider_id,providerKey,d.provider_account_ref]);
    if(!account.length)throw new Error("Financing provider deposit account is unavailable");

    const existing=await sql.query<any>(`select id,attempt_no as "attemptNo",provider_reference as "providerReference",checkout_url as "checkoutUrl",status from financing_deposit_payment_attempts where deposit_payment_id=$1 and status in ('initiated','pending','authorized') order by attempt_no desc limit 1 for update`,[d.id]);
    let attempt=existing[0];
    if(!attempt){
      const n=await sql.query<{n:number}>(`select coalesce(max(attempt_no),0)+1 as n from financing_deposit_payment_attempts where deposit_payment_id=$1`,[d.id]);
      const id=`fdpa_${crypto.randomUUID().replaceAll("-","")}`;
      await sql.query(`insert into financing_deposit_payment_attempts(id,deposit_payment_id,attempt_no,provider_key,status) values($1,$2,$3,$4,'initiated')`,[id,d.id,n[0]?.n??1,providerKey]);
      attempt={id,attemptNo:n[0]?.n??1,status:"initiated"};
    }
    if(attempt.providerReference&&attempt.checkoutUrl){
      return {done:true as const,result:{depositPaymentId:d.id,attemptId:attempt.id,status:attempt.status,checkoutUrl:validateCheckoutUrl(attempt.checkoutUrl,providerKey),existing:true}};
    }
    const claim=crypto.randomUUID();
    const claimed=await sql.query(`update financing_deposit_payment_attempts set initiation_token=$2,initiation_expires_at=now()+interval '2 minutes',status='pending',updated_at=now()
      where id=$1 and provider_reference is null and (initiation_token is null or initiation_expires_at<now()) returning id`,[attempt.id,claim]);
    if(!claimed.length)return {done:true as const,result:{depositPaymentId:d.id,attemptId:attempt.id,status:"pending",checkoutUrl:null,initializing:true}};
    return {done:false as const,d,providerKey,driverKey:providers[0].driver_key??undefined,attemptId:attempt.id,claim};
  });
  if(prepared.done)return prepared.result;

  const adapter=await getPaymentAdapter(prepared.providerKey,prepared.driverKey);
  if(!adapter.supportsIdempotentInitialization)throw new Error("Payment provider does not support duplicate-safe deposit initialization");
  if(!adapter.supportsDirectSubaccountSettlement)throw new Error("Payment provider adapter does not support direct financing-provider deposit settlement");
  const publicUrl=env("ELEMARKET_PUBLIC_URL");
  const callbackUrl=publicUrl?`${publicUrl.replace(/\/$/,"")}/financing/deposit-return?depositPaymentId=${encodeURIComponent(prepared.d.id)}`:undefined;
  const external=await adapter.createPayment({
    paymentId:prepared.d.id,attemptId:prepared.attemptId,amount:String(prepared.d.amount),currency:prepared.d.currency,method:prepared.d.method,
    customerEmail:String(prepared.d.email),merchantSubaccount:prepared.d.provider_account_ref,
    customerReference:`financing_deposit:${prepared.d.application_id}`,idempotencyKey:prepared.attemptId,callbackUrl,
  });
  const safe=validateCheckoutUrl(external.checkoutUrl,prepared.providerKey);
  const sql=await getSql();
  const bound=await sql.query(`update financing_deposit_payment_attempts set provider_reference=$1,checkout_url=$2,status=$3,metadata=$4::jsonb,initiation_token=null,initiation_expires_at=null,updated_at=now() where id=$5 and initiation_token=$6 returning id`,
    [external.providerReference,safe??null,external.status,JSON.stringify(external.metadata??{}),prepared.attemptId,prepared.claim]);
  if(!bound.length)throw new Error("Financing deposit initiation lease lost");
  await sql.query(`update financing_deposit_payments set provider_reference=coalesce(provider_reference,$1),status=case when $2='completed' then 'completed' when $2='authorized' then 'authorized' when $2='failed' then 'failed' else status end,updated_at=now() where id=$3`,
    [external.providerReference,external.status,prepared.d.id]);
  if(external.status==="completed")await sql.query(`update customer_financing_applications set initial_deposit_status='paid',updated_at=now() where id=$1`,[prepared.d.application_id]);
  else if(external.status==="authorized")await sql.query(`update customer_financing_applications set initial_deposit_status='authorized',updated_at=now() where id=$1`,[prepared.d.application_id]);
  return {depositPaymentId:prepared.d.id,attemptId:prepared.attemptId,status:external.status,checkoutUrl:safe??null,existing:false};
}

export async function applyFinancingDepositWebhook(input:{providerKey:string;eventId:string;providerReference:string;status:"authorized"|"completed"|"failed"|"refunded";amount:number;currency:string;payloadHash:string}){
  assertCommerceExecutionAllowed("applyFinancingDepositWebhook");
  return withTransaction(async(sql)=>{
    const rows=await sql.query<any>(`select d.*,a.id as attempt_id,a.status as attempt_status from financing_deposit_payment_attempts a join financing_deposit_payments d on d.id=a.deposit_payment_id where a.provider_key=$1 and a.provider_reference=$2 limit 1 for update of a,d`,
      [input.providerKey,input.providerReference]);
    if(!rows.length)return null;
    const d=rows[0];
    if(Math.abs(Number(d.amount)-Number(input.amount))>0.001||d.currency!==input.currency)throw new Error("Financing deposit webhook amount mismatch");
    await sql.query(`insert into financing_deposit_webhook_events(provider_key,event_id,provider_reference,payload_hash,status) values($1,$2,$3,$4,$5) on conflict(provider_key,event_id) do nothing`,[input.providerKey,input.eventId,input.providerReference,input.payloadHash,input.status]);
    const ev=await sql.query<any>(`select * from financing_deposit_webhook_events where provider_key=$1 and event_id=$2 for update`,[input.providerKey,input.eventId]);
    if(ev[0]?.payload_hash!==input.payloadHash)throw new Error("Financing deposit webhook replay payload mismatch");
    if(ev[0]?.processed_at)return {duplicate:true,depositPaymentId:d.id,status:d.status};
    const next=input.status==="completed"?"completed":input.status==="authorized"?"authorized":input.status==="refunded"?"refunded":"failed";
    const allowed =
      (d.status==="initiated"&&["authorized","completed","failed"].includes(next)) ||
      (d.status==="authorized"&&["completed","failed"].includes(next)) ||
      (d.status==="completed"&&next==="refunded") ||
      d.status===next;
    if(!allowed)throw new Error("Invalid financing deposit state transition");
    await sql.query(`update financing_deposit_payments set status=$2,provider_reference=coalesce(provider_reference,$3),updated_at=now() where id=$1`,[d.id,next,input.providerReference]);
    await sql.query(`update financing_deposit_payment_attempts set status=case when $2='refunded' then 'failed' else $2 end,updated_at=now() where id=$1`,[d.attempt_id,next]);
    await sql.query(`update customer_financing_applications set initial_deposit_status=$2,updated_at=now() where id=$1`,[d.application_id,next==="completed"?"paid":next]);
    await sql.query(`update financing_deposit_webhook_events set processed_at=now() where provider_key=$1 and event_id=$2`,[input.providerKey,input.eventId]);
    return {duplicate:false,depositPaymentId:d.id,applicationId:d.application_id,status:next};
  });
}

export async function completePreviewFinancingDepositServer(input:{depositPaymentId:string;userId:string}){
  assertCommerceExecutionAllowed("completePreviewFinancingDepositServer");
  if(getElemarketEnvironment()!=="development"&&getElemarketEnvironment()!=="preview")throw new Error("Preview financing deposits are disabled");
  return withTransaction(async(sql)=>{
    const rows=await sql.query<any>(`select id,application_id,status from financing_deposit_payments where id=$1 and user_id=$2 for update`,[input.depositPaymentId,input.userId]);
    if(rows.length!==1)throw new Error("Financing deposit payment not found");
    if(rows[0].status==="completed")return {completed:true,replayed:true};
    if(!["initiated","authorized"].includes(rows[0].status))throw new Error("Financing deposit payment is not completable");
    await sql.query(`update financing_deposit_payments set status='completed',provider_reference=coalesce(provider_reference,$2),updated_at=now() where id=$1`,[rows[0].id,`preview_${rows[0].id}`]);
    await sql.query(`update financing_deposit_payment_attempts set status='completed',provider_reference=coalesce(provider_reference,id),updated_at=now() where deposit_payment_id=$1 and status in ('initiated','pending','authorized')`,[rows[0].id]);
    await sql.query(`update customer_financing_applications set initial_deposit_status='paid',updated_at=now() where id=$1`,[rows[0].application_id]);
    return {completed:true,replayed:false};
  });
}


export async function retryFinancingDepositPaymentServer(input:{depositPaymentId:string;userId:string}){
  assertCommerceExecutionAllowed("retryFinancingDepositPaymentServer");
  await withTransaction(async(sql)=>{
    const rows=await sql.query<any>(`select id,application_id,status from financing_deposit_payments where id=$1 and user_id=$2 for update`,[input.depositPaymentId,input.userId]);
    if(rows.length!==1)throw new Error("Financing deposit payment not found");
    if(rows[0].status==="completed")return;
    if(rows[0].status!=="failed")throw new Error("Only a failed financing deposit can be retried");
    await sql.query(`update financing_deposit_payments set status='initiated',provider_reference=null,updated_at=now() where id=$1`,[rows[0].id]);
    await sql.query(`update customer_financing_applications set initial_deposit_status='pending',updated_at=now() where id=$1`,[rows[0].application_id]);
  });
  return createFinancingDepositExternalIntent(input);
}
