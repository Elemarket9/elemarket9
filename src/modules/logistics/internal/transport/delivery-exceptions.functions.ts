import {randomUUID} from "node:crypto";
import {createServerFn} from "@tanstack/react-start";
import {z} from "zod";
import {authMiddleware,getAuthenticatedUserId} from "@/modules/identity/public/auth/middleware";
import {requireFreshSession} from "@/modules/identity/public/auth/verify.server";
import {requirePartnerAccess} from "@/lib/partner/authorization.server";
import {lockCompanyOperation} from "@/lib/partner/transaction-authority.server";
import {withTransaction,getSql} from "@/lib/db";
import type {JsonObject} from "@/lib/db-types";
import {lockHandoverAuthority} from "./handover-authority.server";
import {isSharedEnvironment} from "@/lib/env.server";
const codes=['customer_unavailable','wrong_address','refused','damaged','missing_item','failed_delivery','otp_expired','sms_outage','connectivity','phone_unavailable','uncollected','return_to_sender','collection_failed','dispute'] as const;
export const listDeliveryExceptions=createServerFn({method:'GET'}).middleware([authMiddleware]).handler(async({context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAccess(actor,'delivery');const sql=await getSql();
 const manager=['owner','admin','operator'].includes(access.role);
 const jobs=await sql.query<JsonObject>(`select j.id,j.order_id as "orderId",j.status,j.handover_kind as "handoverKind",j.collection_due_at::text as "collectionDueAt"
   from delivery_jobs j join delivery_providers p on p.id=j.provider_id where p.partner_organization_id=$1
   and ($3::boolean or(j.handover_rider_user_id=$2 and elemarket_authorized_handover_person(j.id,$2))) order by j.updated_at desc limit 200`,[access.organizationId,actor,manager]);
 const events=await sql.query<JsonObject>(`select e.job_id as "jobId",e.event_type as "eventType",e.exception_code as "exceptionCode",e.reason,e.actor_user_id as "actorId",e.created_at::text as "createdAt"
   from delivery_operation_events e join delivery_jobs j on j.id=e.job_id where e.organization_id=$1
   and ($3::boolean or(j.handover_rider_user_id=$2 and elemarket_authorized_handover_person(j.id,$2))) order by e.created_at desc limit 200`,[access.organizationId,actor,manager]);
 return {jobs,events,codes,manager};
});
export const recordDeliveryException=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({jobId:z.string().min(1).max(128),code:z.enum(codes),reason:z.string().trim().min(12).max(1000),action:z.enum(['record','fail','request_return','confirm_return']).default('record')}))
 .handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAccess(actor,'delivery');await requireFreshSession();
 const manager=['owner','admin','operator'].includes(access.role);
 return withTransaction(async tx=>{
  if(manager)await lockCompanyOperation(tx,access.organizationId,actor);
  else await lockHandoverAuthority(tx,access.organizationId,data.jobId,actor,isSharedEnvironment(),false);
  const scope=(await tx.query<{order_id:string}>(`select j.order_id from delivery_jobs j join delivery_providers p on p.id=j.provider_id where j.id=$1 and p.partner_organization_id=$2`,[data.jobId,access.organizationId]))[0];
  if(!scope)throw new Error('Delivery job unavailable');
  await tx.query(`select id from orders where id=$1 for update`,[scope.order_id]);
  const job=(await tx.query<{status:string;shipment_id:string|null;handover_rider_user_id:string|null;collection_due_at:Date|null}>(`select status,shipment_id,handover_rider_user_id,collection_due_at from delivery_jobs where id=$1 for update`,[data.jobId]))[0];
  if(!manager&&job.handover_rider_user_id!==actor)throw new Error('Assigned personnel required');
  if(data.code==='uncollected' && (!job.collection_due_at||new Date(job.collection_due_at).getTime()>Date.now()))throw new Error('Collection deadline has not elapsed');
  if(data.action!=='record'){
   const status=data.action==='fail'?'failed':data.action==='request_return'?'return_requested':'returned';
   if(data.action==='confirm_return'&&!manager)throw new Error('Company operations must confirm return custody');
   await tx.query(`update delivery_handover_requests set state='failed',updated_at=now() where job_id=$1 and state in ('issuing','issued')`,[data.jobId]);
   await tx.query(`update otp_challenges c set status='superseded',updated_at=now() from delivery_otp_verifiers v where v.job_id=$1 and c.id=v.challenge_id and v.consumed_at is null and c.status in ('sending','pending')`,[data.jobId]);
   await tx.query(`update delivery_jobs set status=$2,failure_reason=$3 where id=$1`,[data.jobId,status,data.reason]);
   if(status==='returned'&&job.shipment_id)await tx.query(`update shipments set status='returned' where id=$1`,[job.shipment_id]);
  }
  await tx.query(`insert into delivery_operation_events(id,job_id,organization_id,actor_user_id,event_type,exception_code,reason)
   values($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),data.jobId,access.organizationId,actor,data.action==='request_return'?'return_requested':data.action==='confirm_return'?'returned':data.code==='uncollected'?'uncollected':data.code==='collection_failed'?'collection_failed':'exception',data.code,data.reason]);
  return {recorded:true,receiptConfirmed:false};
 });
});
