import {lockCompanyOperation} from "@/lib/partner/transaction-authority.server";
import {createServerFn} from "@tanstack/react-start";
import {z} from "zod";
import {authMiddleware,getAuthenticatedUserId} from "@/modules/identity/public/auth/middleware";
import {requireFreshSession} from "@/modules/identity/public/auth/verify.server";
import {requirePartnerAdmin} from "@/lib/partner/authorization.server";
import {getSql,withTransaction} from "@/lib/db";
import type {JsonObject} from "@/lib/db-types";
const id=z.string().min(1).max(128);
export const loadAllocationPolicy=createServerFn({method:'GET'}).middleware([authMiddleware]).handler(async({context})=>{
 const access=await requirePartnerAdmin(getAuthenticatedUserId(context),'delivery');const sql=await getSql();
 const providers=await sql.query<{id:string;name:string}>(`select id,name from delivery_providers where partner_organization_id=$1 and status='active' order by name`,[access.organizationId]);
 const policies=await sql.query<JsonObject>(`select policy.provider_id as "providerId",policy.enabled,policy.modes,policy.priority,policy.availability_source as "availabilitySource",policy.valid_until::text as "validUntil"
   from delivery_allocation_policies policy join delivery_providers p on p.id=policy.provider_id where p.partner_organization_id=$1`,[access.organizationId]);
 const allocations=await sql.query<JsonObject>(`select a.shipment_id as "shipmentId",a.created_job_id as "jobId",a.availability_source as "availabilitySource",a.quote_id as "quoteId",a.approved_at::text as "allocatedAt"
   from shipment_delivery_allocations a join delivery_providers p on p.id=a.provider_id where p.partner_organization_id=$1 order by a.approved_at desc limit 100`,[access.organizationId]);
 return {providers,policies,allocations};
});
export const configureAllocationPolicy=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({providerId:id,enabled:z.boolean(),priority:z.number().int().min(0).max(10000),modes:z.array(z.enum(['delivery','pickup'])).min(1).max(2),minLat:z.number().finite().min(-90).max(90),maxLat:z.number().finite().min(-90).max(90),minLon:z.number().finite().min(-180).max(180),maxLon:z.number().finite().min(-180).max(180),maxWeightKg:z.number().positive().max(100000).optional(),validUntil:z.string().datetime({offset:true}),evidenceReference:z.string().trim().min(8).max(500)}).refine(v=>v.minLat<=v.maxLat&&v.minLon<=v.maxLon,'Invalid service area'))
 .handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAdmin(actor,'delivery');await requireFreshSession();
 if(Date.parse(data.validUntil)<=Date.now()||Date.parse(data.validUntil)>Date.now()+31*86400000)throw new Error('Availability must expire within 31 days');
 return withTransaction(async tx=>{
  await lockCompanyOperation(tx,access.organizationId,actor,true);
  if(!(await tx.query(`select id from partner_organizations where id=$1 and status='active' for update`,[access.organizationId]))[0])throw new Error('Company unavailable');
  if(!(await tx.query(`select id from delivery_providers where id=$1 and partner_organization_id=$2 and status='active' for update`,[data.providerId,access.organizationId]))[0])throw new Error('Provider unavailable');
  await tx.query(`insert into delivery_allocation_policies(provider_id,enabled,priority,modes,min_lat,max_lat,min_lon,max_lon,max_weight_kg,availability_source,evidence_reference,valid_until,updated_by)
   values($1,$2,$3,$4::text[],$5,$6,$7,$8,$9,'configured',$10,$11::timestamptz,$12)
   on conflict(provider_id) do update set enabled=excluded.enabled,priority=excluded.priority,modes=excluded.modes,min_lat=excluded.min_lat,max_lat=excluded.max_lat,min_lon=excluded.min_lon,max_lon=excluded.max_lon,max_weight_kg=excluded.max_weight_kg,
    availability_source='configured',evidence_reference=excluded.evidence_reference,valid_until=excluded.valid_until,updated_by=excluded.updated_by,updated_at=now()`,[data.providerId,data.enabled,data.priority,data.modes,data.minLat,data.maxLat,data.minLon,data.maxLon,data.maxWeightKg??null,data.evidenceReference,data.validUntil,actor]);
  await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'allocation.policy.updated','provider',$3,'success',$4::jsonb)`,[access.organizationId,actor,data.providerId,JSON.stringify({availabilitySource:'configured',enabled:data.enabled,validUntil:data.validUntil})]);
  return {configured:true,availabilitySource:'configured'};
 });
});
