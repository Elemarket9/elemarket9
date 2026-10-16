import { assertPortalOperationHost } from "@/lib/security/portal-access.server";
import { getSql } from "@/lib/db";
import { getCookie } from "@tanstack/react-start/server";
export type PartnerCapability = "delivery" | "customer_financing" | "merchant_financing";
export type PartnerRole = "owner" | "admin" | "operator" | "analyst" | "rider";
export async function requirePartnerAccess(userId: string, capability: PartnerCapability, write = false) {
  assertPortalOperationHost("provider");
  const sql = await getSql();
  const selectedOrganization = getCookie("elemarket_company") ?? null;
  const rows = await sql.query<{organizationId:string; organizationName:string; role:PartnerRole;canDispatch:boolean}>(
    `select o.id as "organizationId",o.name as "organizationName",u.role,
      (elemarket_has_personnel_capability(o.id,u.user_id,'dispatcher') or elemarket_has_personnel_capability(o.id,u.user_id,'supervisor')) as "canDispatch"
      from partner_organization_users u join partner_organizations o on o.id=u.organization_id and o.status='active' join partner_organization_capabilities c on c.organization_id=o.id and c.capability=$2 where u.user_id=$1 and u.status='active' and ($3::text is null or o.id=$3) order by o.id limit 2`, [userId, capability, selectedOrganization]);
  if (rows.length !== 1) throw new Error(rows.length ? "Ambiguous partner organization access" : "Partner access denied");
  if (write && !["owner","admin","operator"].includes(rows[0].role) && !(capability==='delivery'&&rows[0].canDispatch)) throw new Error("Partner write access denied");
  return {...rows[0],role:capability==='delivery'&&rows[0].canDispatch&&['analyst','rider'].includes(rows[0].role)?'operator' as PartnerRole:rows[0].role};
}
export async function requirePartnerAdmin(userId:string, capability:PartnerCapability){
 const access=await requirePartnerAccess(userId,capability,true); if(!["owner","admin"].includes(access.role)) throw new Error("Partner administrator access required"); return access;
}

/** Rider identity is a separate least-privilege partner role, not an operations admin. */
export async function requireDeliveryRiderAccess(userId: string) {
 const access = await requirePartnerAccess(userId, "delivery");
 if (access.role !== "rider") throw new Error("Only an authenticated delivery rider may initiate or verify handover");
 return access;
}

/** Resolve the rider membership from the JOB's organization rather than selecting
 * an arbitrary/default company. Allows multi-provider riders without tenant bleed. */
export async function requireDeliveryRiderForJob(userId: string, jobId: string) {
 assertPortalOperationHost("provider");
 const sql=await getSql();
 const rows=await sql.query<{organizationId:string;organizationName:string;role:PartnerRole}>(
 `select o.id as "organizationId",o.name as "organizationName",pu.role
  from delivery_jobs j join delivery_providers p on p.id=j.provider_id and p.status='active'
  join partner_organizations o on o.id=p.partner_organization_id and o.status='active'
  join partner_organization_capabilities c on c.organization_id=o.id and c.capability='delivery'
  join partner_organization_users pu on pu.organization_id=o.id
   and pu.user_id=$1 and pu.status='active'
  join "user" u on u.id=pu.user_id and u."emailVerified"=true
  where j.id=$2 and elemarket_authorized_handover_person(j.id,$1)`,[userId,jobId]);
 if(rows.length!==1) throw new Error("Active assigned-provider rider membership required");
 return rows[0];
}
