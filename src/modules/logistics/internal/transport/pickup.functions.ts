import {lockCompanyOperation} from "@/lib/partner/transaction-authority.server";
import {randomUUID} from "node:crypto";
import {createServerFn} from "@tanstack/react-start";
import {z} from "zod";
import {authMiddleware,getAuthenticatedUserId} from "@/modules/identity/public/auth/middleware";
import {requireFreshSession} from "@/modules/identity/public/auth/verify.server";
import {ghanaPhoneSchema} from "@/modules/identity/public/auth/phone";
import {requirePartnerAccess,requirePartnerAdmin} from "@/lib/partner/authorization.server";
import {getSql,withTransaction} from "@/lib/db";
import type {JsonObject} from "@/lib/db-types";
import {isSharedEnvironment} from "@/lib/env.server";
import {enforceRateLimit} from "@/lib/security/rate-limit.server";
import {lockHandoverAuthority} from "./handover-authority.server";
const id=z.string().trim().min(1).max(128);

export const createPickupLocation=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({name:z.string().trim().min(2).max(160),address:z.string().trim().min(8).max(400),phone:ghanaPhoneSchema,latitude:z.number().finite().min(-90).max(90),longitude:z.number().finite().min(-180).max(180)}))
 .handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAdmin(actor,'delivery');await requireFreshSession();
 await enforceRateLimit('pickup-location-create',{windowSeconds:3600,maxRequests:20,subject:actor});
 return withTransaction(async tx=>{
  await lockCompanyOperation(tx,access.organizationId,actor,true);
  if(!(await tx.query(`select id from partner_organizations where id=$1 and status='active' for update`,[access.organizationId]))[0])throw new Error('Company unavailable');
  const key=`pickup_${randomUUID()}`;
  await tx.query(`insert into pickup_locations(id,organization_id,name,address,contact_phone,latitude,longitude,created_by) values($1,$2,$3,$4,$5,$6,$7,$8)`,[key,access.organizationId,data.name,data.address,data.phone,data.latitude,data.longitude,actor]);
  await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome) values($1,$2,'pickup.location.created','pickup_location',$3,'success')`,[access.organizationId,actor,key]);
  return {id:key};
 });
});
export const setPickupLocationStatus=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({locationId:id,status:z.enum(['active','suspended','closed']),reason:z.string().trim().min(8).max(500)})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAdmin(actor,'delivery');await requireFreshSession();
 return withTransaction(async tx=>{
  await lockCompanyOperation(tx,access.organizationId,actor,true);
  const row=await tx.query(`update pickup_locations set status=$3 where id=$1 and organization_id=$2 returning id`,[data.locationId,access.organizationId,data.status]);
  if(!row[0])throw new Error('Location unavailable');
  await tx.query(`update delivery_handover_requests r set state='failed',updated_at=now() from delivery_jobs j
    where r.job_id=j.id and j.pickup_location_id=$1 and r.state in ('issuing','issued')`,[data.locationId]);
  await tx.query(`update otp_challenges c set status='superseded',updated_at=now() from delivery_otp_verifiers v join delivery_jobs j on j.id=v.job_id
    where c.id=v.challenge_id and j.pickup_location_id=$1 and c.status in ('sending','pending')`,[data.locationId]);
  await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'pickup.location.status','pickup_location',$3,'success',$4::jsonb)`,[access.organizationId,actor,data.locationId,JSON.stringify({status:data.status,reason:data.reason})]);
  return {updated:true};
 });
});
export const listPickupOperations=createServerFn({method:'GET'}).middleware([authMiddleware]).handler(async({context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAccess(actor,'delivery');const sql=await getSql();
 const manager=['owner','admin','operator'].includes(access.role);
 const locations=await sql.query<JsonObject>(`select l.id,l.name,l.address,l.status from pickup_locations l
  where l.organization_id=$1 and ($3::boolean or exists(select 1 from pickup_location_attendants a where a.location_id=l.id and a.user_id=$2 and a.status='active'
    and elemarket_has_personnel_capability(l.organization_id,$2,'pickup_attendant'))) order by l.name`,[access.organizationId,actor,manager]);
 const jobs=await sql.query<JsonObject>(`select j.id,j.order_id as "orderId",j.status,j.pickup_location_id as "locationId",l.name as "locationName",
   j.handover_rider_user_id as "personnelId",j.pickup_arrived_at::text as "arrivedAt",j.collection_due_at::text as "collectionDueAt",
   o.delivery_contact_snapshot_verified as "contactVerified",exists(select 1 from order_delivery_holds h where h.order_id=o.id and h.active) as "onHold",
   (select n.status from delivery_notification_outbox n where n.job_id=j.id and n.kind='collection_ready') as "notificationStatus"
   from delivery_jobs j join pickup_locations l on l.id=j.pickup_location_id
   join delivery_providers p on p.id=j.provider_id and p.partner_organization_id=l.organization_id join orders o on o.id=j.order_id
   where l.organization_id=$1 and ($3::boolean or exists(select 1 from pickup_location_attendants a
    where a.location_id=l.id and a.user_id=$2 and a.status='active' and elemarket_has_personnel_capability(l.organization_id,$2,'pickup_attendant')))
   order by j.updated_at desc limit 200`,[access.organizationId,actor,manager]);
 return {locations,jobs,manager,actor,organizationId:access.organizationId};
});
export const listEligiblePickupLocations=createServerFn({method:'GET'}).middleware([authMiddleware]).handler(async()=>{
 const sql=await getSql();return sql.query<{id:string;name:string;address:string}>(`select l.id,l.name,l.address from pickup_locations l
 join partner_organizations o on o.id=l.organization_id and o.status='active'
 where l.status='active' and exists(select 1 from delivery_providers p where p.partner_organization_id=o.id and p.status='active'
 and (not $1::boolean or p.environment='production')) order by l.name limit 200`,[isSharedEnvironment()]);
});
export const chooseShipmentPickup=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({shipmentId:id,locationId:id})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);await requireFreshSession();
 return withTransaction(async tx=>{
  const location=(await tx.query<{organization_id:string}>(`select organization_id from pickup_locations where id=$1`,[data.locationId]))[0];
  if(!location)throw new Error('Pickup location unavailable');
  await tx.query(`select id from partner_organizations where id=$1 and status='active' for update`,[location.organization_id]);
  const order=(await tx.query<{id:string}>(`select o.id from orders o join shipments s on s.order_id=o.id where s.id=$1 and o.user_id=$2
    and o.status in ('paid','confirmed','fulfilling','shipped') for update of o`,[data.shipmentId,actor]))[0];
  if(!order)throw new Error('Shipment unavailable');
  if(!(await tx.query(`select id from pickup_locations where id=$1 and status='active' for update`,[data.locationId]))[0])throw new Error('Pickup location unavailable');
  const shipment=await tx.query(`update shipments set fulfillment_method='pickup',pickup_location_id=$2 where id=$1 and status in ('pending','packed') returning id`,[data.shipmentId,data.locationId]);
  if(!shipment[0])throw new Error('Shipment is no longer selectable');
  await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'pickup.customer_selected','shipment',$3,'success',$4::jsonb)`,[location.organization_id,actor,data.shipmentId,JSON.stringify({locationId:data.locationId})]);
  return {selected:true};
 });
});
export const recordPickupArrival=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({jobId:id})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAccess(actor,'delivery');
 await enforceRateLimit('pickup-arrival',{windowSeconds:60,maxRequests:30,subject:actor});
 return withTransaction(async tx=>{
  await lockHandoverAuthority(tx,access.organizationId,data.jobId,actor,isSharedEnvironment(),false);
  await tx.query(`select o.id from orders o join delivery_jobs j on j.order_id=o.id where j.id=$1 for update of o`,[data.jobId]);
  const rows=await tx.query(`update delivery_jobs set handover_rider_user_id=$2,pickup_arrived_at=coalesce(pickup_arrived_at,now()),
   collection_due_at=coalesce(collection_due_at,now()+interval '7 days') where id=$1 and handover_kind='pickup' and status='in_transit'
   and (handover_rider_user_id is null or handover_rider_user_id=$2) returning id`,[data.jobId,actor]);
  if(!rows[0])throw new Error('Parcel is unavailable or assigned to another attendant');
  await tx.query(`insert into delivery_operation_events(id,job_id,organization_id,actor_user_id,event_type,reason) values($1,$2,$3,$4,'arrived','Parcel received at authorized pickup location')`,[randomUUID(),data.jobId,access.organizationId,actor]);
  await tx.query(`insert into delivery_notification_outbox(id,job_id,kind) values($1,$2,'collection_ready') on conflict(job_id,kind) do nothing`,[randomUUID(),data.jobId]);
  return {arrived:true,notificationQueued:true};
 });
});
