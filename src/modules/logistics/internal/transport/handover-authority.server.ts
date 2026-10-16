import type { Sql } from "@/lib/db";

/** Recheck authority inside EVERY handover transaction. Holding these rows
 * serializes receipt with organization/provider suspension and rider revocation.
 * Workforce management acquires the organization before membership/job rows. */
export async function lockHandoverAuthority(
  tx: Pick<Sql, "query">,
  organizationId: string,
  jobId: string,
  riderId: string,
  production: boolean,
  arrivalRequired = true,
): Promise<void> {
  const org = await tx.query(`select id from partner_organizations
    where id=$1 and status='active' for update`, [organizationId]);
  if (!org[0]) throw new Error("Delivery organization is inactive");
  const provider = await tx.query(`select p.id from delivery_providers p
    join delivery_jobs j on j.provider_id=p.id
    where j.id=$1 and p.partner_organization_id=$2 and p.status='active'
      and (not $3::boolean or p.environment='production') for update of p`,
    [jobId, organizationId, production]);
  if (!provider[0]) throw new Error("Delivery provider is unavailable");
  const member = await tx.query(`select pu.user_id from partner_organization_users pu
    join "user" u on u.id=pu.user_id and u."emailVerified"=true
    join partner_organization_capabilities c on c.organization_id=pu.organization_id and c.capability='delivery'
    where pu.organization_id=$1 and pu.user_id=$2
      and pu.status='active' for update of pu,c`,
    [organizationId, riderId]);
  if (!member[0]) throw new Error("Active authenticated rider membership required");
  const job = (await tx.query<{handover_kind:string;pickup_location_id:string|null;pickup_arrived_at:string|null}>(
    `select handover_kind,pickup_location_id,pickup_arrived_at from delivery_jobs where id=$1`,[jobId]))[0];
  if(!job)throw new Error("Delivery job unavailable");
  const capability=job.handover_kind==='pickup'?'pickup_attendant':'rider';
  const personnel=await tx.query(`select user_id from delivery_personnel_capabilities
    where organization_id=$1 and user_id=$2 and capability=$3 and status='active' for update`,[organizationId,riderId,capability]);
  if(!personnel[0])throw new Error("Exact accepted rider or attendant capability required");
  if(job.handover_kind==='pickup'){
    const location=await tx.query(`select l.id from pickup_locations l join pickup_location_attendants a
      on a.location_id=l.id and a.organization_id=l.organization_id
      where l.id=$1 and l.organization_id=$2 and l.status='active' and a.user_id=$3 and a.status='active'
      for update of l,a`,[job.pickup_location_id,organizationId,riderId]);
    if(!location[0] || (arrivalRequired && !job.pickup_arrived_at))throw new Error("Parcel is not available at an authorized pickup location");
  }
}
