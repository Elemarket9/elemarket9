import { randomUUID } from "node:crypto";
import { generateHandoverCode, handoverMac, verifyHandoverMac } from "./delivery-otp-crypto";
import { assertPortalOperationHost } from "@/lib/security/portal-access.server";
import { getDeliverySmsTransport } from "./delivery-sms/registry.server";
import { isSharedEnvironment } from "@/lib/env.server";
import type { JsonObject } from "@/lib/db-types";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { getSql, withTransaction } from "@/lib/db";
import { requirePartnerAccess, requirePartnerAdmin, requireDeliveryRiderForJob } from "@/lib/partner/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { assignDeliveryManually } from "../dispatch.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { lockHandoverAuthority } from "./handover-authority.server";
import {lockCompanyOperation} from "@/lib/partner/transaction-authority.server";


export const assignOrderDelivery = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ orderId: z.string().trim().min(1).max(128) }))
  .handler(async ({ data }) => assignDeliveryManually(data.orderId));

export const loadDeliveryPartnerDashboard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = getAuthenticatedUserId(context);
    const access = await requirePartnerAccess(userId, "delivery");
    if(access.role === "rider") throw new Error("Rider accounts must use the restricted /provider/rider dashboard");
    const sql = await getSql();
    const providers = await sql.query<{
      id: string;
      name: string;
      status: string;
      environment: string;
    }>(
      `select id,name,status,environment from delivery_providers where partner_organization_id=$1 order by name`,
      [access.organizationId],
    );
    const jobs = await sql.query<JsonObject>(
      `select j.id,j.order_id as "orderId",j.status,j.handover_rider_user_id as "handoverRiderUserId",j.provider_reference as "providerReference",j.tracking_url as "trackingUrl",j.proof_of_delivery_url as "proofOfDeliveryUrl",j.failure_reason as "failureReason",j.version,j.assigned_at::text as "assignedAt",j.accepted_at::text as "acceptedAt",j.picked_up_at::text as "pickedUpAt",j.in_transit_at::text as "inTransitAt",j.delivered_at::text as "deliveredAt",j.failed_at::text as "failedAt",j.updated_at::text as "updatedAt",o.address,o.delivery_tier as "deliveryTier",o.delivery_total::float8 as "deliveryTotal",o.grand_total::float8 as "grandTotal",o.delivery_contact_snapshot_verified as "contactVerified",
      exists(select 1 from order_delivery_holds h where h.order_id=o.id and h.active) as "deliveryOnHold",m.name as "merchantName",p.name as "providerName" from delivery_jobs j join delivery_providers p on p.id=j.provider_id and p.partner_organization_id=$1 join orders o on o.id=j.order_id join merchants m on m.id=o.merchant_id where ($2::boolean=false or j.handover_rider_user_id=$3) order by j.updated_at desc limit 200`,
      [access.organizationId, false, userId],
    );
    const counts = await sql.query<{ status: string; count: number }>(
      `select j.status,count(*)::bigint as count from delivery_jobs j join delivery_providers p on p.id=j.provider_id where p.partner_organization_id=$1 and ($2::boolean=false or j.handover_rider_user_id=$3) group by j.status`,
      [access.organizationId, false, userId],
    );
    const riders = ["owner", "admin"].includes(access.role) ? await sql.query<{userId:string;name:string;email:string}>(
      `select pu.user_id as "userId",coalesce(u.name,'Rider') as name,u.email
       from partner_organization_users pu join "user" u on u.id=pu.user_id
       where pu.organization_id=$1 and pu.status='active' and elemarket_has_personnel_capability(pu.organization_id,pu.user_id,'rider') order by u.name`,
      [access.organizationId],
    ) : [];
    return { organization: access.organizationName, currentUserId:userId, role: access.role, providers, jobs, counts, riders };
  });
/** The origin registry is configured on each delivery provider record, never
 * inferred from a globally hardcoded brand or an arbitrary rider input. */
export function isAllowedTrackingUrl(input:string, allowedOrigins:string[]):boolean {
  try {
    const url=new URL(input);
    if(url.protocol!=="https:" || url.username || url.password || url.hash || url.port && url.port!=="443")return false;
    return allowedOrigins.some(origin=>{
      try {
        const item=new URL(origin);
        return item.protocol==="https:" && !item.username && !item.password && !item.search && !item.hash && item.pathname==="/" && item.origin===url.origin;
      }catch{return false;}
    });
  }catch{return false;}
}

const updateSchema = z
  .object({
    jobId: z.string().min(1).max(128),
    expectedVersion: z.number().int().nonnegative(),
    status: z.enum([
      "accepted",
      "picked_up",
      "in_transit",
      "failed",
      "cancelled",
      "return_requested",
      "returned",
    ]),
    trackingUrl: z
      .string()
      .url()
      .max(2000)
      .refine((v) => v.startsWith("https://"), "HTTPS tracking URL required")
      .optional(),
    proofOfDeliveryUrl: z
      .string()
      .url()
      .max(2000)
      .refine((v) => v.startsWith("https://"), "HTTPS proof URL required")
      .optional(),
    failureReason: z.string().trim().max(500).optional(),
  })
  .superRefine((v, c) => {
    if (v.status === "failed" && !v.failureReason)
      c.addIssue({
        code: "custom",
        message: "Failure reason is required",
        path: ["failureReason"],
      });
  });
export const updateDeliveryJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(updateSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const access = await requirePartnerAccess(userId, "delivery", true);
    await enforceRateLimit("partner-delivery-update", {
      windowSeconds: 60,
      maxRequests: 60,
      subject: `${access.organizationId}:${userId}`,
    });
    // Delivery changes and partner audit must commit or roll back together.
    return withTransaction(async (sql) => {
      await lockCompanyOperation(sql,access.organizationId,userId);
      if(data.proofOfDeliveryUrl) throw new Error("Unverified external delivery-proof URLs are not accepted; only verified job-bound evidence can be submitted");
      if(data.trackingUrl){
        const providers=await sql.query<{tracking_allowed_origins:string[]}>(
          `select p.tracking_allowed_origins from delivery_jobs j join delivery_providers p on p.id=j.provider_id
            where j.id=$1 and p.partner_organization_id=$2 and p.status='active' for update of j`,
          [data.jobId,access.organizationId],
        );
        if(!providers[0] || !isAllowedTrackingUrl(data.trackingUrl,providers[0].tracking_allowed_origins??[]))
          throw new Error("Tracking URL origin has not been approved for this delivery provider");
      }
      const rows = await sql.query<{ id: string }>(
        `update delivery_jobs j set status=$3,tracking_url=coalesce($4,tracking_url),proof_of_delivery_url=coalesce($5,proof_of_delivery_url),failure_reason=case when $3='failed' then $6 else failure_reason end,picked_up_at=case when $3='picked_up' then coalesce(picked_up_at,now()) else picked_up_at end,updated_at=now() from delivery_providers p where j.id=$1 and p.id=j.provider_id and p.partner_organization_id=$2 and p.status='active' and (not $8::boolean or p.environment='production') and j.version=$7 returning j.id,j.version`,
        [
          data.jobId,
          access.organizationId,
          data.status,
          data.trackingUrl ?? null,
          data.proofOfDeliveryUrl ?? null,
          data.failureReason ?? null,
          data.expectedVersion,
          isSharedEnvironment(),
        ],
      );
      if (rows.length !== 1)
        throw new Error("Delivery job changed or is no longer available; refresh and retry");
      if(['failed','cancelled'].includes(data.status)){
        await sql.query(`update delivery_handover_requests set state='failed',updated_at=now() where job_id=$1 and state in ('issuing','issued')`,[data.jobId]);
        await sql.query(`update otp_challenges c set status='superseded',updated_at=now() from delivery_otp_verifiers v where v.job_id=$1 and c.id=v.challenge_id and v.consumed_at is null and c.status in ('pending','sending')`,[data.jobId]);
      }
      await sql.query(
        `insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'delivery.status.updated','delivery_job',$3,'success',$4::jsonb)`,
        [access.organizationId, userId, data.jobId, JSON.stringify({ status: data.status })],
      );
      return { updated: true };
    });
  });

/** Provider managers bind a distinct active rider account to a delivery job.
 * A generic provider operator cannot initiate a customer handover OTP. */
export const assignHandoverRider = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ jobId: z.string().min(1).max(128), riderUserId: z.string().min(1).max(128) }))
  .handler(async ({ data, context }) => {
    const userId=getAuthenticatedUserId(context);
    const access=await requirePartnerAdmin(userId, "delivery");
    await requireFreshSession();
    await enforceRateLimit("partner-rider-assignment", { windowSeconds:60,maxRequests:30,subject:userId });
    return withTransaction(async sql => {
      await lockCompanyOperation(sql,access.organizationId,userId,true);
      await sql.query(`select id from partner_organizations where id=$1 and status='active' for update`,[access.organizationId]);
      const assigned=await sql.query<{id:string}>(
        `update delivery_jobs j set handover_rider_user_id=$3
         from delivery_providers p join partner_organization_users pu
           on pu.organization_id=p.partner_organization_id and pu.user_id=$3
           and pu.status='active' and elemarket_has_personnel_capability(pu.organization_id,pu.user_id,'rider')
         join "user" verified_rider on verified_rider.id=pu.user_id and verified_rider."emailVerified"=true
         where j.id=$1 and p.id=j.provider_id and p.partner_organization_id=$2
           and p.status='active' and j.status in ('assigned','accepted','picked_up','in_transit')
           and j.handover_rider_user_id is distinct from $3 returning j.id`,
        [data.jobId,access.organizationId,data.riderUserId]);
      if (!assigned[0]) throw new Error("Rider assignment unchanged or unavailable; check job and rider status");
      await sql.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata)
        values($1,$2,'delivery.rider.assigned','delivery_job',$3,'success',$4::jsonb)`,
        [access.organizationId,userId,data.jobId,JSON.stringify({riderUserId:data.riderUserId})]);
      return {assigned:true as const};
    });
  });

/** A delivery challenge for EVERY order is issued ONLY when the assigned rider
 * explicitly requests it at physical handover. Neither a provider manager nor
 * merchant, customer, scheduler or webhook may initiate the SMS. */
export const requestDeliveryHandoverOtp = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ jobId: z.string().trim().min(1).max(128), atRecipient: z.literal(true) }))
  .handler(async ({ data, context }) => {
    const riderId=getAuthenticatedUserId(context);
    const access=await requireDeliveryRiderForJob(riderId,data.jobId);
    await enforceRateLimit("handover-rider-request",{windowSeconds:600,maxRequests:3,subject:`${access.organizationId}:${data.jobId}:${riderId}`});
    // First reserve this exact rider/job/order handover before contacting SMS.
    // Serializing here prevents two concurrent requests binding different codes.
    const token=randomUUID();
    const target=await withTransaction(async tx => {
      await lockHandoverAuthority(tx,access.organizationId,data.jobId,riderId,isSharedEnvironment());
      const rows=await tx.query<{order_id:string;user_id:string;phone:string}>(
        `select o.id as order_id,o.user_id,o.delivery_contact_phone as phone
         from orders o join delivery_jobs j on j.order_id=o.id
         join delivery_providers p on p.id=j.provider_id
         join partner_organization_users pu on pu.organization_id=p.partner_organization_id
           and pu.user_id=$3 and pu.status='active' and elemarket_authorized_handover_person(j.id,pu.user_id)
         where j.id=$1 and p.partner_organization_id=$2 and p.status='active'
           and (not $4::boolean or p.environment='production')
           and j.handover_rider_user_id=$3 and j.status='in_transit'
           and o.status='shipped'
           and o.delivery_contact_snapshot_verified=true
           and o.delivery_contact_phone ~ '^[+]233[25][0-9]{8}$'
           and not exists(select 1 from order_delivery_holds h where h.order_id=o.id and h.active)
           and not exists(select 1 from order_delivery_handover h where h.job_id=j.id and h.verified_at is not null)
         for update of o,j`,
        [data.jobId,access.organizationId,riderId,isSharedEnvironment()]);
      const row=rows[0];
      if (!row?.phone) throw new Error("Only the assigned rider may request OTP for an eligible in-transit delivery");
      const reserved=await tx.query<{order_id:string}>(
        `insert into delivery_handover_requests(order_id,job_id,rider_user_id,request_token,state,started_at,expires_at,updated_at)
         values ($1,$2,$3,$4,'issuing',now(),now()+interval '5 minutes',now())
         on conflict(job_id) do update set
          order_id=excluded.order_id,rider_user_id=excluded.rider_user_id,request_token=excluded.request_token,
          state='issuing',started_at=now(),expires_at=excluded.expires_at,updated_at=now()
         where delivery_handover_requests.state='failed' or delivery_handover_requests.expires_at<=now()
         returning order_id`,
        [row.order_id,data.jobId,riderId,token]);
      if (!reserved[0]) throw new Error("Delivery OTP already requested; wait for expiry before retrying");
      return row;
    });
    let challengeId:string|undefined;
    try {
      // Issue purpose-bound challenge under ELEMARKET control. Never rely on an
      // SMS operator's phone+code verification (which is not challenge-bound).
      const code=generateHandoverCode();
      challengeId=`otp_${randomUUID().replaceAll("-","")}`;
      const challenge=challengeId;
      const digest=handoverMac(challenge,data.jobId,target.order_id,riderId,target.phone,code);
      await withTransaction(async tx=>{
        await lockHandoverAuthority(tx,access.organizationId,data.jobId,riderId,isSharedEnvironment());
        // Serialize all new handover issuance for this customer phone, including
        // two simultaneous parcels from different orders. Only one active SMS
        // challenge per destination/purpose may be issuable at a time.
        await tx.query(`select pg_advisory_xact_lock(hashtext($1))`,[`handover:${target.phone}`]);
        const live=await tx.query(`select order_id from delivery_handover_requests where order_id=$1
          and request_token=$2 and job_id=$3 and state='issuing' and expires_at>now() for update`,[target.order_id,token,data.jobId]);
        if(!live[0])throw new Error("Handover request reservation expired");
        await tx.query(`update otp_challenges set status='expired',updated_at=now()
          where destination=$1 and purpose='delivery_handover' and status in ('sending','pending') and expires_at<=now()`,[target.phone]);
        const busy=await tx.query(`select 1 from otp_challenges where destination=$1 and purpose='delivery_handover'
          and status in ('sending','pending') and expires_at>now() limit 1`,[target.phone]);
        if(busy[0])throw new Error("An active handover already exists for this number");
        await tx.query(`insert into otp_challenges
          (id,user_id,destination,purpose,provider,status,expires_at,attempts,max_attempts,cooldown_until)
          values($1,$2,$3,'delivery_handover','elemarket_delivery','sending',now()+interval '5 minutes',0,5,now()+interval '60 seconds')`,
          [challenge,target.user_id,target.phone]);
        await tx.query(`insert into delivery_otp_verifiers(challenge_id,order_id,job_id,rider_user_id,mac_hex)
          values($1,$2,$3,$4,$5)`,[challenge,target.order_id,data.jobId,riderId,digest]);
      });
      // SMS provider ONLY transports this customer-facing code. SMS acceptance
      // is not proof of actual delivery. Plaintext is never stored or logged.
      await getDeliverySmsTransport().send(target.phone,
        `ELEMARKET delivery code ${code}. Share ONLY with the authorized delivery person after seeing and inspecting your parcel. Expires in 5 minutes. NOT for login or payment.`);
      await withTransaction(async tx=>{
        await lockHandoverAuthority(tx,access.organizationId,data.jobId,riderId,isSharedEnvironment());
        const alive=await tx.query<{id:string}>(
          `select o.id from orders o join delivery_jobs j on j.order_id=o.id
           join delivery_providers p on p.id=j.provider_id
           join partner_organization_users pu on pu.organization_id=p.partner_organization_id
             and pu.user_id=$3 and pu.status='active' and elemarket_authorized_handover_person(j.id,pu.user_id)
           join delivery_handover_requests r on r.order_id=o.id and r.job_id=j.id
           where o.id=$1 and j.id=$2 and j.handover_rider_user_id=$3
             and p.partner_organization_id=$4 and p.status='active'
             and (not $7::boolean or p.environment='production')
             and r.request_token=$5 and r.state='issuing' and r.expires_at>now()
             and o.status='shipped' and j.status='in_transit'
             and o.delivery_contact_phone=$6 and o.delivery_contact_snapshot_verified=true
             and not exists(select 1 from order_delivery_holds h where h.order_id=o.id and h.active)
           for update of o,j,r`,
          [target.order_id,data.jobId,riderId,access.organizationId,token,target.phone,isSharedEnvironment()]);
        if(!alive[0]) throw new Error("Delivery changed while sending code. Request a new OTP after review");
        await tx.query(`update otp_challenges set status='pending',updated_at=now()
          where id=$1 and status='sending' and expires_at>now()`,[challengeId]);
        await tx.query(
          `insert into order_delivery_handover(order_id,job_id,challenge_id,issued_at,initiated_by)
           values($1,$2,$3,now(),$4)
           on conflict(job_id) do update set challenge_id=excluded.challenge_id,
             job_id=excluded.job_id,issued_at=now(),initiated_by=excluded.initiated_by,
             verified_at=null,verified_by=null
           where order_delivery_handover.verified_at is null`,
          [target.order_id,data.jobId,challengeId,riderId]);
        await tx.query(`update delivery_handover_requests set state='issued',updated_at=now()
          where order_id=$1 and request_token=$2 and state='issuing'`,[target.order_id,token]);
        await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata)
          values($1,$2,'delivery.otp_requested_by_rider','delivery_job',$3,'success',$4::jsonb)`,
          [access.organizationId,riderId,data.jobId,JSON.stringify({orderId:target.order_id,method:'rider_at_handover'})]);
      });
      return {issued:true as const,expiresInSeconds:300};
    } catch(error){
      await withTransaction(async tx=>{
        await tx.query(`update delivery_handover_requests set state='failed',updated_at=now()
         where order_id=$1 and request_token=$2 and state='issuing'`,[target.order_id,token]);
        if(challengeId) await tx.query(`update otp_challenges set status='failed',updated_at=now()
          where id=$1 and status in ('pending','sending')`,[challengeId]);
      });
      throw error;
    }
  });

/** Only the SAME assigned rider can consume their initiated order-bound OTP.
 * Successful verification is the sole ordinary receipt-confirmation action for every order. */
export const verifyDeliveryHandoverOtp=createServerFn({method:"POST"})
 .middleware([authMiddleware])
 .validator(z.object({jobId:z.string().trim().min(1).max(128),code:z.string().regex(/^\d{6}$/),
   proofOfDeliveryUrl:z.string().url().max(2000).refine(u=>u.startsWith("https://"),"HTTPS proof URL required").optional()}))
 .handler(async({data,context})=>{
   if(data.proofOfDeliveryUrl) throw new Error("Unverified delivery proof URLs are not accepted. Use rider OTP to confirm receipt.");
   const riderId=getAuthenticatedUserId(context);
   const access=await requireDeliveryRiderForJob(riderId,data.jobId);
   await enforceRateLimit("handover-rider-verify",{windowSeconds:600,maxRequests:8,subject:`${access.organizationId}:${data.jobId}:${riderId}`});
   const attempt=await withTransaction(async tx=>{
     await lockHandoverAuthority(tx,access.organizationId,data.jobId,riderId,isSharedEnvironment());
     // Order -> job -> challenge row locks serialize verification against job
     // reassignment, another verification attempt, and support holds.
     const orders=await tx.query<{id:string;status:string;merchant_id:string;user_id:string;delivery_contact_phone:string}>(
       `select o.id,o.status,o.merchant_id,o.user_id,o.delivery_contact_phone from orders o
        join delivery_jobs j on j.order_id=o.id where j.id=$1 and o.status in ('shipped','delivered') for update of o`,[data.jobId]);
     if(!orders[0])return {received:false as const};
     const order=orders[0];
     // Safe idempotent retry: a lost HTTP response does not require another
     // OTP, create a second receipt, or restart the immutable protection clock.
     if(order.status==='delivered' || order.status==='shipped'){
       const prior=await tx.query(`select 1 from order_delivery_handover h
         join delivery_otp_verifiers v on v.challenge_id=h.challenge_id and v.consumed_at is not null
         join delivery_jobs j on j.id=h.job_id and j.handover_rider_user_id=$2 and j.status='delivered'
         where h.order_id=$1 and h.job_id=$3 and h.verified_at is not null
           and h.verified_by=$2 and h.initiated_by=$2`,[order.id,riderId,data.jobId]);
       if(prior[0]) return {received:true as const,protectionHours:24,alreadyConfirmed:true as const};
       if(order.status==='delivered') return {received:false as const};
     }
     const jobs=await tx.query<{id:string}>(`select j.id from delivery_jobs j
       join delivery_providers p on p.id=j.provider_id and p.status='active'
       join partner_organizations po on po.id=p.partner_organization_id and po.status='active'
       join partner_organization_users pu on pu.organization_id=po.id and pu.user_id=$3
        and pu.status='active' and elemarket_authorized_handover_person(j.id,pu.user_id)
       where j.id=$1 and j.order_id=$2 and j.status='in_transit'
        and j.handover_rider_user_id=$3 and po.id=$4
        and (not $5::boolean or p.environment='production') for update of j,pu`,
       [data.jobId,order.id,riderId,access.organizationId,isSharedEnvironment()]);
     if(!jobs[0])return {received:false as const};
     const challenges=await tx.query<{id:string;mac_hex:string;destination:string;attempts:number;max_attempts:number}>(
       `select c.id,v.mac_hex,c.destination,c.attempts,c.max_attempts
        from order_delivery_handover h
        join otp_challenges c on c.id=h.challenge_id
        join delivery_otp_verifiers v on v.challenge_id=c.id and v.order_id=h.order_id and v.job_id=h.job_id
          and v.rider_user_id=$3 and v.consumed_at is null
        join delivery_handover_requests r on r.order_id=h.order_id and r.job_id=h.job_id
          and r.rider_user_id=$3 and r.state='issued' and r.expires_at>now()
        where h.job_id=$1 and h.order_id=$2 and h.initiated_by=$3 and h.verified_at is null
          and c.status='pending' and c.expires_at>now() and c.attempts<c.max_attempts
          and c.purpose='delivery_handover' and c.provider='elemarket_delivery'
          and c.destination=$4 and c.user_id=$5
          for update of c,h,r,v`,[data.jobId,order.id,riderId,order.delivery_contact_phone,order.user_id]);
     const ch=challenges[0];
     if(!ch) return {received:false as const};
     if((await tx.query(`select 1 from order_delivery_holds where order_id=$1 and active`,[order.id])).length)
       return {received:false as const};
     const incoming=handoverMac(ch.id,data.jobId,order.id,riderId,ch.destination,data.code);
     if(!verifyHandoverMac(ch.mac_hex,incoming)){
       await tx.query(`update otp_challenges set attempts=attempts+1,
         status=case when attempts+1>=max_attempts then 'locked' else status end,updated_at=now() where id=$1`,[ch.id]);
       return {received:false as const}; // Persist the failed attempt; do NOT throw inside tx.
     }
     const used=await tx.query(`update otp_challenges set status='verified',verified_at=now(),
       attempts=attempts+1,updated_at=now() where id=$1 and status='pending' and expires_at>now() returning id`,[ch.id]);
     if(!used[0])throw new Error("OTP was already consumed");
     await tx.query(`update delivery_otp_verifiers set consumed_at=now() where challenge_id=$1 and consumed_at is null`,[ch.id]);
     const verified=await tx.query(`update order_delivery_handover set verified_at=now(),verified_by=$2
       where order_id=$1 and job_id=$3 and challenge_id=$4 and initiated_by=$2 and verified_at is null returning order_id`,
       [order.id,riderId,data.jobId,ch.id]);
     if(!verified[0])throw new Error("Handover changed during verification");
     const completedJob=await tx.query(`update delivery_jobs set status='delivered',proof_of_delivery_url=coalesce($2,proof_of_delivery_url),
       delivered_at=now(),updated_at=now() where id=$1 and status='in_transit' returning id,shipment_id`,[data.jobId,data.proofOfDeliveryUrl??null]);
     if(!completedJob[0])throw new Error("Job changed during verified receipt");
     if(completedJob[0].shipment_id){
       const shipment=await tx.query(`update shipments set status='delivered',delivered_at=now(),updated_at=now()
         where id=$1 and status in ('pending','packed','shipped','in_transit','out_for_delivery') returning id`,[completedJob[0].shipment_id]);
       if(!shipment[0])throw new Error("Shipment cannot be marked received in its current state");
     }
     // No order-wide settlement clock until every parcel, quantity and job is verified.
     const delivery=await tx.query<{delivered_at:string|null}>(`select elemarket_order_delivered_at($1)::text as delivered_at`,[order.id]);
     const fullReceipt=Boolean(delivery[0]?.delivered_at);
     if(fullReceipt){
       const updated=await tx.query(`update orders set status='delivered',delivery_confirmation_source='delivery_otp',
         customer_received_at=$2::timestamptz,updated_at=now() where id=$1 and status='shipped' returning id`,[order.id,delivery[0].delivered_at]);
       if(!updated[0])throw new Error("Cannot finish already changed order");
       await tx.query(`insert into merchant_order_status_history(order_id,merchant_id,from_status,to_status,actor_user_id,note)
         values($1,$2,'shipped','delivered',$3,'All fulfillment units individually OTP-verified')`,[order.id,order.merchant_id,riderId]);
     }
     await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata)
       values($1,$2,'delivery.otp_receipt','delivery_job',$3,'success',$4::jsonb)`,
       [access.organizationId,riderId,data.jobId,JSON.stringify({orderId:order.id,challengeId:ch.id})]);
     return {received:true as const,protectionHours:24,orderFullyReceived:fullReceipt};
   });
   if(!attempt.received)throw new Error("Delivery code is invalid, expired, locked, or handover is not authorized");
   return attempt;
 });

/** Job-scoped rider queue across any number of provider memberships. Never
 * resolve a rider from an ambiguous organization-global "first member". */
export const loadMyRiderJobs=createServerFn({method:"GET"}).middleware([authMiddleware]).validator(z.object({page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(50).default(25)})).handler(async({data,context})=>{
 assertPortalOperationHost("provider");
 const userId=getAuthenticatedUserId(context);
 const sql=await getSql();
 const jobs=await sql.query<JsonObject>(`select j.id,j.order_id as "orderId",j.status,j.version,
   j.updated_at::text as "updatedAt",j.failure_reason as "failureReason",j.proof_of_delivery_url as "proofOfDeliveryUrl",
   o.address,o.delivery_contact_snapshot_verified as "contactVerified",
   exists(select 1 from order_delivery_holds h where h.order_id=o.id and h.active) as "deliveryOnHold",
   p.name as "providerName",p.partner_organization_id as "organizationId"
   from delivery_jobs j join delivery_providers p on p.id=j.provider_id and p.status='active'
   join partner_organizations org on org.id=p.partner_organization_id and org.status='active'
   join partner_organization_users member on member.organization_id=org.id and member.user_id=$1 and member.status='active' and elemarket_authorized_handover_person(j.id,member.user_id)
   join "user" u on u.id=member.user_id and u."emailVerified"=true
   join orders o on o.id=j.order_id
   where j.handover_rider_user_id=$1 and j.handover_kind='delivery' order by j.updated_at desc limit $2 offset $3`,
   [userId,data.pageSize,(data.page-1)*data.pageSize]);
 return {jobs,page:data.page,pageSize:data.pageSize};
});
export const updateMyRiderJob=createServerFn({method:"POST"}).middleware([authMiddleware])
 .validator(z.object({jobId:z.string().min(1).max(128),expectedVersion:z.number().int().nonnegative(),status:z.enum(['accepted','picked_up','in_transit','failed']),failureReason:z.string().trim().max(500).optional()}))
 .handler(async({data,context})=>{
  const riderId=getAuthenticatedUserId(context);const access=await requireDeliveryRiderForJob(riderId,data.jobId);
  await enforceRateLimit('rider-job-transition',{windowSeconds:60,maxRequests:30,subject:`${riderId}:${data.jobId}`});
  if(data.status==='failed' && !data.failureReason)throw new Error('A failure reason is required');
  return withTransaction(async tx=>{
   const jobs=await tx.query(`update delivery_jobs j set status=$3,failure_reason=case when $3='failed' then $6 else failure_reason end,updated_at=now()
    from delivery_providers p join partner_organizations org on org.id=p.partner_organization_id and org.status='active'
    join partner_organization_users pu on pu.organization_id=org.id and pu.user_id=$4 and pu.status='active' and elemarket_authorized_handover_person(j.id,pu.user_id)
    where j.id=$1 and j.provider_id=p.id and p.status='active' and (not $7::boolean or p.environment='production')
      and org.id=$2 and j.handover_rider_user_id=$4 and j.version=$5
      and j.status in ('assigned','accepted','picked_up','in_transit')
      and not exists(select 1 from order_delivery_holds h where h.order_id=j.order_id and h.active)
      returning j.id`,[data.jobId,access.organizationId,data.status,riderId,data.expectedVersion,data.failureReason??null,isSharedEnvironment()]);
   if(!jobs[0])throw new Error('Job changed, is held, or rider is not authorized');
   await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata)
    values($1,$2,'rider.job_transition','delivery_job',$3,'success',$4::jsonb)`,
    [access.organizationId,riderId,data.jobId,JSON.stringify({status:data.status})]);
   return {updated:true};
  });
 });
/** Reassignment invalidates all existing OTP verification credentials inside
 * the same transaction that changes the rider. */
export const reassignHandoverRider=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({jobId:z.string().min(1).max(128),newRiderUserId:z.string().min(1).max(128),reason:z.string().trim().min(8).max(300)}))
 .handler(async({data,context})=>{
  const actor=getAuthenticatedUserId(context);const access=await requirePartnerAdmin(actor,'delivery');
  await requireFreshSession();await enforceRateLimit('rider-reassignment',{windowSeconds:60,maxRequests:15,subject:actor});
  return withTransaction(async tx=>{
   await lockCompanyOperation(tx,access.organizationId,actor,true);
   const org=await tx.query(`select id from partner_organizations where id=$1 and status='active' for update`,[access.organizationId]);
   if(!org[0])throw new Error('Provider inactive');
   const rows=await tx.query<{id:string;old_rider:string|null}>(`select j.id,j.handover_rider_user_id as old_rider from delivery_jobs j
     join delivery_providers p on p.id=j.provider_id and p.status='active'
     where j.id=$1 and p.partner_organization_id=$2 and j.status in ('assigned','accepted','picked_up','in_transit')
     for update of j`,[data.jobId,access.organizationId]);
   if(!rows[0] || rows[0].old_rider===data.newRiderUserId)throw new Error('Job unavailable or rider unchanged');
   const eligible=await tx.query(`select 1 from partner_organization_users pu join "user" u on u.id=pu.user_id and u."emailVerified"=true
      where pu.organization_id=$1 and pu.user_id=$2 and pu.status='active' and elemarket_has_personnel_capability(pu.organization_id,pu.user_id,'rider') for update of pu`,
      [access.organizationId,data.newRiderUserId]);
   if(!eligible[0])throw new Error('Replacement must be an accepted, active verified rider');
   // Old migration 0191 prohibits reassignment while a request is active;
   // cancel it here BEFORE updating the job while holding the job lock.
   await tx.query(`update delivery_handover_requests set state='failed',updated_at=now() where job_id=$1 and state in ('issuing','issued')`,[data.jobId]);
   await tx.query(`update otp_challenges c set status='superseded',updated_at=now() from order_delivery_handover h
      where h.job_id=$1 and c.id=h.challenge_id and c.status in ('sending','pending') and h.verified_at is null`,[data.jobId]);
   // Reservation is removed, not transferred. Replacement rider must arrive and
   // request their OWN fresh OTP (not reuse the old rider's challenge).
   await tx.query(`update delivery_jobs set handover_rider_user_id=$2 where id=$1`,[data.jobId,data.newRiderUserId]);
   await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata)
    values($1,$2,'delivery.rider.reassigned','delivery_job',$3,'success',$4::jsonb)`,
    [access.organizationId,actor,data.jobId,JSON.stringify({previousRider:rows[0].old_rider,newRider:data.newRiderUserId,reason:data.reason})]);
   return {reassigned:true};
  });
 });
