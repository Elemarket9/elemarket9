import {randomUUID} from "node:crypto";
import {getSql,withTransaction} from "@/lib/db";
import {isSharedEnvironment} from "@/lib/env.server";

/** Only persisted matching quotes and explicit current provider policies qualify.
 * Configured service availability is labelled; it is not a live courier claim. */
export async function allocateEligibleShipments(limit=25){
 const sql=await getSql();
 const pending=await sql.query<{id:string}>(`select s.id from shipments s join orders o on o.id=s.order_id
  where s.status in ('pending','packed','shipped') and o.status in ('paid','confirmed','fulfilling','shipped')
  and exists(select 1 from shipment_items where shipment_id=s.id)
  and not exists(select 1 from delivery_jobs where shipment_id=s.id or (order_id=s.order_id and shipment_id is null))
  order by s.created_at,s.id limit $1`,[Math.max(1,Math.min(100,limit))]);
 let allocated=0,attention=0;
 for(const shipment of pending){
  const candidates=await sql.query<{provider_id:string;organization_id:string;quote_id:string}>(`
   select p.id as provider_id,p.partner_organization_id as organization_id,q.id as quote_id
   from shipments s join orders o on o.id=s.order_id join delivery_quotes purchased on purchased.id=o.delivery_quote_id
   join delivery_quotes q on q.user_id=o.user_id and q.merchant_id=o.merchant_id and q.fingerprint=purchased.fingerprint
    and q.dest_address=purchased.dest_address and q.dest_lat is not distinct from purchased.dest_lat
    and q.dest_lon is not distinct from purchased.dest_lon and q.price<=o.delivery_total
    and (q.id=purchased.id or q.expires_at>now())
   join delivery_providers p on p.id=q.provider_id and p.status='active'
   join partner_organizations org on org.id=p.partner_organization_id and org.status='active'
   join delivery_allocation_policies policy on policy.provider_id=p.id and policy.enabled and policy.valid_until>now()
   where s.id=$1 and s.fulfillment_method=any(policy.modes)
    and (policy.max_weight_kg is null or s.weight_kg<=policy.max_weight_kg)
    and ((s.fulfillment_method='pickup' and exists(select 1 from pickup_locations l where l.id=s.pickup_location_id and l.organization_id=org.id and l.status='active'))
      or (s.fulfillment_method='delivery' and q.dest_lat between policy.min_lat and policy.max_lat and q.dest_lon between policy.min_lon and policy.max_lon))
    and (not $2::boolean or p.environment='production') order by policy.priority,q.price,q.eta_minutes,p.id,q.id limit 10`,[shipment.id,isSharedEnvironment()]);
  let done=false;
  for(const candidate of candidates){
   try{
    done=await withTransaction(async tx=>{
     if(!(await tx.query(`select id from partner_organizations where id=$1 and status='active' for update`,[candidate.organization_id]))[0])return false;
     if(!(await tx.query(`select id from delivery_providers where id=$1 and status='active' and partner_organization_id=$2 for update`,[candidate.provider_id,candidate.organization_id]))[0])return false;
     await tx.query(`select o.id from orders o join shipments s on s.order_id=o.id where s.id=$1 for update of o`,[shipment.id]);
     const target=(await tx.query<{order_id:string;fulfillment_method:string;pickup_location_id:string|null}>(`select s.order_id,s.fulfillment_method,s.pickup_location_id from shipments s join orders o on o.id=s.order_id
       where s.id=$1 and s.status in ('pending','packed','shipped') and o.status in ('paid','confirmed','fulfilling','shipped')
       and not exists(select 1 from delivery_jobs where shipment_id=s.id or (order_id=s.order_id and shipment_id is null)) for update of s`,[shipment.id]))[0];
     if(!target)return false;
     const evidence=(await tx.query<{availability_source:string}>(`select policy.availability_source from delivery_allocation_policies policy
      join delivery_quotes q on q.provider_id=policy.provider_id join orders o on o.id=$3
      join delivery_quotes purchased on purchased.id=o.delivery_quote_id join shipments s on s.id=$4 and s.order_id=o.id
      where policy.provider_id=$1 and q.id=$2 and policy.enabled and policy.valid_until>now()
       and q.user_id=o.user_id and q.merchant_id=o.merchant_id and q.fingerprint=purchased.fingerprint
       and q.dest_address=purchased.dest_address and q.dest_lat is not distinct from purchased.dest_lat and q.dest_lon is not distinct from purchased.dest_lon
       and q.price<=o.delivery_total and (q.id=purchased.id or q.expires_at>now())
       and s.fulfillment_method=any(policy.modes) and (policy.max_weight_kg is null or s.weight_kg<=policy.max_weight_kg)
       and (s.fulfillment_method='pickup' or(q.dest_lat between policy.min_lat and policy.max_lat and q.dest_lon between policy.min_lon and policy.max_lon))
       for update of policy,q`,[candidate.provider_id,candidate.quote_id,target.order_id,shipment.id]))[0];
     if(!evidence)return false;
     if(target.pickup_location_id && !(await tx.query(`select id from pickup_locations where id=$1 and organization_id=$2 and status='active' for update`,[target.pickup_location_id,candidate.organization_id]))[0])return false;
     const job=`dj_${randomUUID()}`;
     const inserted=await tx.query(`insert into shipment_delivery_allocations(shipment_id,provider_id,approved_by,quote_id,availability_source)
      values($1,$2,'policy:automatic',$3,$4) on conflict(shipment_id) do nothing returning shipment_id`,[shipment.id,candidate.provider_id,candidate.quote_id,evidence.availability_source]);
     if(!inserted[0])return false;
     await tx.query(`insert into delivery_jobs(id,order_id,shipment_id,provider_id,handover_kind,pickup_location_id)
      values($1,$2,$3,$4,$5,$6)`,[job,target.order_id,shipment.id,candidate.provider_id,target.fulfillment_method,target.pickup_location_id]);
     await tx.query(`update shipment_delivery_allocations set created_job_id=$2 where shipment_id=$1`,[shipment.id,job]);
     await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata)
      values($1,'system:allocation','shipment.policy_allocated','shipment',$2,'success',$3::jsonb)`,[candidate.organization_id,shipment.id,JSON.stringify({jobId:job,quoteId:candidate.quote_id,availabilitySource:evidence.availability_source})]);
     return true;
    });
    if(done){allocated++;break;}
   }catch{ /* Candidate changed or a competing allocator won; no partial job survives. */ }
  }
  if(!done)attention++;
 }
 return {scanned:pending.length,allocated,attention};
}
