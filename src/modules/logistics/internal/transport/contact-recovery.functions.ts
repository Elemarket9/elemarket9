import {randomUUID} from "node:crypto";
import {createServerFn} from "@tanstack/react-start";
import {z} from "zod";
import {authMiddleware,getAuthenticatedUserId} from "@/modules/identity/public/auth/middleware";
import {requireFreshSession} from "@/modules/identity/public/auth/verify.server";
import {requireAdminForUserId} from "@/modules/identity/public/auth/authorization.server";
import {ghanaPhoneSchema} from "@/modules/identity/public/auth/phone";
import {getSql,withTransaction} from "@/lib/db";
import type {JsonObject} from "@/lib/db-types";
import {enforceRateLimit} from "@/lib/security/rate-limit.server";
const id=z.string().trim().min(1).max(128);
export const requestDeliveryContactRecovery=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({orderId:id,newPhone:ghanaPhoneSchema,proofChallengeId:id,identityEvidenceReference:z.string().trim().min(12).max(500)})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);await requireFreshSession();await enforceRateLimit('delivery-phone-recovery',{windowSeconds:86400,maxRequests:3,subject:actor});
 return withTransaction(async tx=>{
  const order=(await tx.query<{delivery_contact_phone:string|null}>(`select delivery_contact_phone from orders where id=$1 and user_id=$2
    and status in ('paid','confirmed','fulfilling','shipped') for update`,[data.orderId,actor]))[0];
  if(!order)throw new Error('Order unavailable for contact recovery');
  const proof=await tx.query(`select id from otp_challenges where id=$1 and user_id=$2 and destination=$3 and purpose='phone_verification'
    and status='verified' and verified_at>=now()-interval '30 minutes' for update`,[data.proofChallengeId,actor,data.newPhone]);
  if(!proof[0])throw new Error('Fresh existing phone-verification proof required for the new number');
  const key=`recovery_${randomUUID()}`;
  await tx.query(`insert into delivery_contact_recoveries(id,order_id,customer_id,old_phone,new_phone,proof_challenge_id,identity_evidence_reference)
    values($1,$2,$3,$4,$5,$6,$7)`,[key,data.orderId,actor,order.delivery_contact_phone,data.newPhone,data.proofChallengeId,data.identityEvidenceReference]);
  await tx.query(`select record_audit_event('delivery.contact.recovery.requested','order',$1,$2,'customer',null,'success',jsonb_build_object('recoveryId',$3::text))`,[data.orderId,actor,key]);
  return {recoveryId:key,status:'requested',independentApprovalsRequired:2};
 });
});
export const listMyContactRecoveries=createServerFn({method:'GET'}).middleware([authMiddleware]).handler(async({context})=>{
 const sql=await getSql();const actor=getAuthenticatedUserId(context);const requests=await sql.query<JsonObject>(`select id,order_id as "orderId",new_phone as "newPhone",status,created_at::text as "createdAt"
   from delivery_contact_recoveries where customer_id=$1 order by created_at desc limit 50`,[getAuthenticatedUserId(context)]);
 const phoneProofs=await sql.query<{id:string;phone:string}>(`select c.id,c.destination as phone from otp_challenges c where c.user_id=$1 and c.purpose='phone_verification'
  and c.status='verified' and c.verified_at>=now()-interval '30 minutes' and not exists(select 1 from delivery_contact_recoveries r where r.proof_challenge_id=c.id) order by c.verified_at desc limit 10`,[actor]);
 return {requests,phoneProofs};
});
export const listContactRecoveryWorkbench=createServerFn({method:'GET'}).middleware([authMiddleware]).handler(async({context})=>{
 const actor=getAuthenticatedUserId(context);await requireAdminForUserId(actor,'admin.support');const sql=await getSql();
 return sql.query<JsonObject>(`select r.id,r.order_id as "orderId",r.customer_id as "customerId",r.old_phone as "oldPhone",r.new_phone as "newPhone",r.identity_evidence_reference as "evidenceReference",r.status,
   (select count(*)::int from delivery_contact_recovery_reviews v where v.recovery_id=r.id and decision='approved') as approvals
   from delivery_contact_recoveries r where r.status='requested' order by r.created_at limit 100`);
});
export const reviewDeliveryContactRecovery=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({recoveryId:id,decision:z.enum(['approved','rejected']),reason:z.string().trim().min(12).max(1000)})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);await requireFreshSession();await requireAdminForUserId(actor,'admin.support');
 await enforceRateLimit('delivery-phone-recovery-review',{windowSeconds:3600,maxRequests:30,subject:actor});
 return withTransaction(async tx=>{
  const scope=(await tx.query<{order_id:string}>(`select order_id from delivery_contact_recoveries where id=$1`,[data.recoveryId]))[0];
  if(!scope)throw new Error('Recovery unavailable');
  await tx.query(`select id from orders where id=$1 for update`,[scope.order_id]);
  const target=await tx.query(`select id from delivery_contact_recoveries where id=$1 and status='requested' and customer_id<>$2 for update`,[data.recoveryId,actor]);
  if(!target[0])throw new Error('Independent review required for a pending recovery');
  await tx.query(`insert into delivery_contact_recovery_reviews(recovery_id,reviewer_id,decision,reason) values($1,$2,$3,$4)`,[data.recoveryId,actor,data.decision,data.reason]);
  let applied=false;
  if(data.decision==='rejected')await tx.query(`update delivery_contact_recoveries set status='rejected' where id=$1`,[data.recoveryId]);
  else {
   const counts=(await tx.query<{n:number}>(`select count(*)::int as n from delivery_contact_recovery_reviews where recovery_id=$1 and decision='approved'`,[data.recoveryId]))[0];
   if(counts.n>=2){const result=(await tx.query<{applied:boolean}>(`select elemarket_apply_contact_recovery($1) as applied`,[data.recoveryId]))[0];applied=result.applied;}
  }
  await tx.query(`select record_audit_event('delivery.contact.recovery.review','order',$1,$2,'admin',null,'success',jsonb_build_object('recoveryId',$3::text,'decision',$4::text,'applied',$5::boolean))`,[scope.order_id,actor,data.recoveryId,data.decision,applied]);
  return {reviewed:true,applied};
 });
});
