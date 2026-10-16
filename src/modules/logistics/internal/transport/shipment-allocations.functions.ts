import {randomUUID} from "node:crypto";
import {createServerFn} from "@tanstack/react-start";
import {z} from "zod";
import {authMiddleware,getAuthenticatedUserId} from "@/modules/identity/public/auth/middleware";
import {requireAdminForUserId} from "@/modules/identity/public/auth/authorization.server";
import {requireFreshSession} from "@/modules/identity/public/auth/verify.server";
import {withTransaction} from "@/lib/db";
import {enforceRateLimit} from "@/lib/security/rate-limit.server";
import {isSharedEnvironment} from "@/lib/env.server";
import type {JsonObject} from "@/lib/db-types";

/** Explicitly allocate each shipment to a contracted, active delivery provider.
 * Not a carrier callback or rider action. This is a transitional manual
 * control until shipment-level provider quote procurement is implemented. */
export const allocateShipmentToDeliveryProvider=createServerFn({method:'POST'})
 .middleware([authMiddleware])
 .validator(z.object({shipmentId:z.string().trim().min(1).max(128),
  providerId:z.string().trim().min(1).max(128),reason:z.string().trim().min(12).max(500)}))
 .handler(async({data,context})=>{
   const actor=getAuthenticatedUserId(context);await requireFreshSession();await requireAdminForUserId(actor,'admin.providers.manage');
   await enforceRateLimit('shipment-provider-approve',{windowSeconds:60,maxRequests:12,subject:actor});
   return withTransaction(async tx=>{
     const scope=(await tx.query<{organization_id:string}>(`select partner_organization_id as organization_id from delivery_providers where id=$1`,[data.providerId]))[0];
     if(!scope?.organization_id)throw new Error('Provider unavailable');
     if(!(await tx.query(`select id from partner_organizations where id=$1 and status='active' for update`,[scope.organization_id]))[0])throw new Error('Company unavailable');
     await tx.query(`select id from delivery_providers where id=$1 for update`,[data.providerId]);
     await tx.query(`select o.id from orders o join shipments s on s.order_id=o.id where s.id=$1 for update of o`,[data.shipmentId]);
     const rows=await tx.query<{shipment_id:string;order_id:string;fulfillment_method:string;pickup_location_id:string|null}>(`
       select s.id as shipment_id,s.order_id,s.fulfillment_method,s.pickup_location_id from shipments s
       join orders o on o.id=s.order_id
       where s.id=$1 and s.status in ('pending','packed','shipped')
         and o.status in ('paid','confirmed','fulfilling','shipped') for update of s,o`,[data.shipmentId]);
     if(!rows[0])throw new Error('Shipment not eligible for new provider allocation');
     const provider=await tx.query(`select p.id from delivery_providers p
       join partner_organizations org on org.id=p.partner_organization_id and org.status='active'
       join partner_organization_capabilities c on c.organization_id=org.id and c.capability='delivery'
       where p.id=$1 and p.status='active' and (not $2::boolean or p.environment='production')
       for update of p`,[data.providerId,isSharedEnvironment()]);
     if(!provider[0]) throw new Error('Delivery provider unavailable');
     const existing=await tx.query(`select 1 from delivery_jobs where order_id=$1 and shipment_id is null limit 1`,[rows[0].order_id]);
     if(existing[0])throw new Error('Legacy order-level delivery job must be safely reconciled before splitting fulfillment');
     const jobId=`dj_${randomUUID().replaceAll('-','')}`;
     const recorded=await tx.query(`insert into shipment_delivery_allocations
       (shipment_id,provider_id,approved_by,created_job_id) values($1,$2,$3,null)
       on conflict(shipment_id) do nothing returning shipment_id`,[data.shipmentId,data.providerId,actor]);
     if(!recorded[0])throw new Error('Shipment has already been allocated; cannot silently change provider');
     const added=await tx.query(`insert into delivery_jobs(id,order_id,shipment_id,provider_id,handover_kind,pickup_location_id)
       values($1,$2,$3,$4,$5,$6) returning id`,[jobId,rows[0].order_id,data.shipmentId,data.providerId,rows[0].fulfillment_method,rows[0].pickup_location_id]);
     if(!added[0])throw new Error('Job provisioning failed');
     await tx.query(`update shipment_delivery_allocations set created_job_id=$2 where shipment_id=$1`,[data.shipmentId,jobId]);
     await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata)
       select p.partner_organization_id,$2,'shipment.provider_approved','shipment',$3,'success',
       jsonb_build_object('deliveryJobId',$4::text,'providerId',$1,'reason',$5::text)
       from delivery_providers p where p.id=$1`,[data.providerId,actor,data.shipmentId,jobId,data.reason]);
     return {shipmentId:data.shipmentId,deliveryJobId:jobId,allocated:true};
   });
 });
export const loadShipmentAllocationReview=createServerFn({method:'GET'}).middleware([authMiddleware]).handler(async({context})=>{
 const actor=getAuthenticatedUserId(context);await requireAdminForUserId(actor,'admin.providers.manage');
 return withTransaction(async tx=>{
  const shipments=await tx.query<{id:string;orderId:string;method:string}>(`select s.id,s.order_id as "orderId",s.fulfillment_method as method from shipments s join orders o on o.id=s.order_id
   where s.status in ('pending','packed','shipped') and o.status in ('paid','confirmed','fulfilling','shipped') and not exists(select 1 from delivery_jobs j where j.shipment_id=s.id or(j.order_id=s.order_id and j.shipment_id is null)) order by s.created_at limit 100`);
  const providers=await tx.query<{id:string;name:string}>(`select p.id,p.name from delivery_providers p join partner_organizations o on o.id=p.partner_organization_id and o.status='active' where p.status='active' and(not $1::boolean or p.environment='production') order by p.name`,[isSharedEnvironment()]);
  const jobs=await tx.query<JsonObject>(`select j.id,j.shipment_id as "shipmentId",j.provider_id as "providerId",j.status from delivery_jobs j where j.shipment_id is not null and j.status in ('assigned','accepted','picked_up','in_transit') order by j.updated_at desc limit 100`);
  return {shipments,providers,jobs};
 });
});
export const reassignShipmentProvider=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({jobId:z.string().min(1).max(128),providerId:z.string().min(1).max(128),reason:z.string().trim().min(12).max(500)})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);await requireFreshSession();await requireAdminForUserId(actor,'admin.providers.manage');
 await enforceRateLimit('shipment-provider-reassignment',{windowSeconds:60,maxRequests:10,subject:actor});
 return withTransaction(async tx=>{
  const scope=(await tx.query<{order_id:string;provider_id:string;organization_id:string;target_org:string}>(`select j.order_id,j.provider_id,p.partner_organization_id as organization_id,np.partner_organization_id as target_org
   from delivery_jobs j join delivery_providers p on p.id=j.provider_id cross join delivery_providers np where j.id=$1 and np.id=$2`,[data.jobId,data.providerId]))[0];
  if(!scope||scope.provider_id===data.providerId||!scope.target_org)throw new Error('Provider reassignment unavailable');
  await tx.query(`select id from partner_organizations where id=any($1::text[]) order by id for update`,[[scope.organization_id,scope.target_org]]);
  const target=await tx.query(`select p.id from delivery_providers p join partner_organizations o on o.id=p.partner_organization_id and o.status='active'
   join partner_organization_capabilities c on c.organization_id=o.id and c.capability='delivery'
   where p.id=$1 and p.status='active' and(not $2::boolean or p.environment='production') for update of p`,[data.providerId,isSharedEnvironment()]);
  if(!target[0])throw new Error('New provider unavailable');
  await tx.query(`select id from orders where id=$1 for update`,[scope.order_id]);
  const job=(await tx.query<{shipment_id:string;provider_id:string;pickup_location_id:string|null}>(`select shipment_id,provider_id,pickup_location_id from delivery_jobs where id=$1
   and status in ('assigned','accepted','picked_up','in_transit') for update`,[data.jobId]))[0];
  if(!job?.shipment_id||job.provider_id!==scope.provider_id)throw new Error('Delivery changed; refresh before reassignment');
  if(job.pickup_location_id && !(await tx.query(`select id from pickup_locations where id=$1 and organization_id=$2 and status='active' for update`,[job.pickup_location_id,scope.target_org]))[0])throw new Error('Pickup custody cannot move silently to another company');
  await tx.query(`update delivery_handover_requests set state='failed',updated_at=now() where job_id=$1 and state in ('issuing','issued')`,[data.jobId]);
  await tx.query(`update otp_challenges c set status='superseded',updated_at=now() from delivery_otp_verifiers v where v.job_id=$1 and c.id=v.challenge_id and v.consumed_at is null and c.status in ('sending','pending')`,[data.jobId]);
  await tx.query(`update shipment_delivery_allocations set provider_id=$2,approved_by=$3,approved_at=now(),quote_id=null,availability_source='manual_review' where shipment_id=$1`,[job.shipment_id,data.providerId,actor]);
  await tx.query(`update delivery_jobs set provider_id=$2 where id=$1`,[data.jobId,data.providerId]);
  for(const org of new Set([scope.organization_id,scope.target_org]))await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata)
   values($1,$2,'shipment.provider.reassigned','delivery_job',$3,'success',$4::jsonb)`,[org,actor,data.jobId,JSON.stringify({oldProvider:scope.provider_id,newProvider:data.providerId,reason:data.reason})]);
  return {reassigned:true,personnelMustBeAssigned:true};
 });
});
