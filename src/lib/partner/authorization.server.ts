import { assertCommerceExecutionAllowed } from "@/lib/security/launch-profile.mjs";
import { assertPortalOperationHost } from "@/lib/security/portal-access.server";
import { getSql } from "@/lib/db";
export type PartnerCapability = "delivery" | "customer_financing" | "merchant_financing";
export type PartnerRole = "owner" | "admin" | "operator" | "analyst";
export async function requirePartnerAccess(userId: string, capability: PartnerCapability, write = false) {
  assertPortalOperationHost("provider");
  const sql = await getSql();
  const rows = await sql.query<{organizationId:string; organizationName:string; role:PartnerRole}>(
    `select o.id as "organizationId",o.name as "organizationName",u.role from partner_organization_users u join partner_organizations o on o.id=u.organization_id and o.status='active' join partner_organization_capabilities c on c.organization_id=o.id and c.capability=$2 where u.user_id=$1 and u.status='active' order by o.id limit 2`, [userId, capability]);
  if (rows.length !== 1) throw new Error(rows.length ? "Ambiguous partner organization access" : "Partner access denied");
  if (write && capability === "delivery") assertCommerceExecutionAllowed("delivery partner execution");
  if (write && !["owner","admin","operator"].includes(rows[0].role)) throw new Error("Partner write access denied");
  return rows[0];
}
export async function requirePartnerAdmin(userId:string, capability:PartnerCapability){
 const access=await requirePartnerAccess(userId,capability,true); if(!["owner","admin"].includes(access.role)) throw new Error("Partner administrator access required"); return access;
}
