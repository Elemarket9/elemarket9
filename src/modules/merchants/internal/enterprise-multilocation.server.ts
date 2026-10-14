import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { requireRoleForUserId } from "@/modules/identity/public/auth/authorization.server";

export type EnterpriseLocationRow = { id:string; name:string; location_type:string; status:string; city:string; country_code:string|null; address:string; latitude:number|null; longitude:number|null; timezone:string; cutoff_time:string|null; external_location_key:string|null; available_units:number; reserved_units:number };

export type EnterpriseStaffRole = "enterprise_admin"|"operations_manager"|"location_manager"|"warehouse_operator"|"inventory_manager"|"fulfillment_operator"|"support_manager"|"analyst";
export type EnterpriseStaffRow = { id:string; user_id:string; name:string; email:string; location_id:string|null; location_name:string|null; role:EnterpriseStaffRole; status:string; created_at:string; updated_at:string };

async function getEnterpriseOrganizationId(merchantId:string){
  const sql=await getSql();
  const rows=await sql.query<{id:string}>(`select id from enterprise_organizations where merchant_id=$1 and status='active'`,[merchantId]);
  if(!rows[0]) throw new Error("Enterprise organization is not active");
  return rows[0].id;
}

async function requireEnterpriseOrgRoles(merchantId:string,userId:string,roles:EnterpriseStaffRole[]){
  await requireRoleForUserId(["customer","merchant","admin"],userId);
  const organizationId=await getEnterpriseOrganizationId(merchantId);
  const sql=await getSql();
  await sql.query(`select assert_enterprise_org_role_access($1,$2,$3::text[])`,[userId,organizationId,roles]);
  return organizationId;
}

async function requireEnterpriseLocationRoles(userId:string,locationId:string,roles:EnterpriseStaffRole[]){
  const sql=await getSql();
  await sql.query(`select assert_enterprise_location_role_access($1,$2,$3::text[])`,[userId,locationId,roles]);
}

export async function requireEnterpriseAdmin(merchantId: string, userId: string) {
  return requireEnterpriseOrgRoles(merchantId,userId,["enterprise_admin"]);
}

export async function listEnterpriseLocations(merchantId: string, userId: string) {
  await requireRoleForUserId(["customer","merchant","admin"],userId);
  const organizationId=await getEnterpriseOrganizationId(merchantId);
  const sql = await getSql();
  const rows = await sql.query<EnterpriseLocationRow>(
    `select l.id,l.name,l.location_type,l.status,l.city,l.country_code,l.address,l.latitude,l.longitude,l.timezone,l.cutoff_time,l.external_location_key,
            coalesce(sum(i.available),0)::int as available_units,
            coalesce(sum(i.reserved),0)::int as reserved_units
       from merchant_inventory_locations l
       left join product_location_inventory i on i.location_id=l.id
      where l.organization_id=$1
        and (
          exists(select 1 from enterprise_location_staff s where s.organization_id=$1 and s.user_id=$2 and s.status='active' and s.role in ('enterprise_admin','operations_manager','analyst','support_manager') and s.location_id is null)
          or exists(select 1 from enterprise_location_staff s where s.organization_id=$1 and s.user_id=$2 and s.status='active' and s.location_id=l.id)
        )
      group by l.id
      order by l.name`, [organizationId,userId],
  );
  if(!rows.length){
    const access=await sql.query<{ok:boolean}>(`select exists(select 1 from enterprise_location_staff where organization_id=$1 and user_id=$2 and status='active') as ok`,[organizationId,userId]);
    if(!access[0]?.ok) throw new Error("Enterprise access denied");
  }
  return rows;
}

export async function createEnterpriseLocation(input: { merchantId: string; userId: string; name: string; address: string; city: string; countryCode?: string; locationType: string; externalLocationKey?: string; latitude?: number; longitude?: number; timezone?: string }) {
  const organizationId = await requireEnterpriseAdmin(input.merchantId, input.userId);
  const sql = await getSql();
  const id = `loc_${randomUUID().replaceAll("-", "")}`;
  await sql.query(`insert into merchant_inventory_locations(id,merchant_id,organization_id,name,address,city,country_code,location_type,external_location_key,latitude,longitude,timezone) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id,input.merchantId,organizationId,input.name.trim(),input.address.trim(),input.city.trim(),(input.countryCode??"GH").toUpperCase(),input.locationType,input.externalLocationKey??id,input.latitude??null,input.longitude??null,input.timezone??"Africa/Accra"]);
  return { id };
}

export async function transferEnterpriseInventory(input: { merchantId: string; userId: string; productId: string; fromLocationId: string; toLocationId: string; quantity: number; idempotencyKey: string }) {
  await requireRoleForUserId(["customer","merchant","admin"],input.userId);
  const organizationId = await getEnterpriseOrganizationId(input.merchantId);
  const sql = await getSql();
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 1_000_000) throw new Error("Invalid quantity");
  if (input.fromLocationId === input.toLocationId) throw new Error("Source and destination must differ");
  const eligible = await sql.query<{ok:boolean}>(`
    select exists (
      select 1 from products p
      join enterprise_organizations e on e.merchant_id=p.merchant_id and e.id=$1
      join merchant_inventory_locations source on source.id=$3 and source.organization_id=e.id and source.merchant_id=p.merchant_id
      join merchant_inventory_locations destination on destination.id=$4 and destination.organization_id=e.id and destination.merchant_id=p.merchant_id
     where p.id=$2 and p.merchant_id=$5 and e.status='active'
       and source.status='active' and destination.status='active'
    ) as ok`, [organizationId,input.productId,input.fromLocationId,input.toLocationId,input.merchantId]);
  if (!eligible[0]?.ok) throw new Error("Inventory transfer locations or product do not belong to this enterprise");
  const inventoryRoles:EnterpriseStaffRole[]=["operations_manager","location_manager","warehouse_operator","inventory_manager"];
  await requireEnterpriseLocationRoles(input.userId,input.fromLocationId,inventoryRoles);
  await requireEnterpriseLocationRoles(input.userId,input.toLocationId,inventoryRoles);
  const id = `tr_${randomUUID().replaceAll("-", "")}`;
  const inserted=await sql.query<{id:string}>(`insert into enterprise_inventory_transfers(id,organization_id,product_id,from_location_id,to_location_id,quantity,status,idempotency_key,requested_by) values($1,$2,$3,$4,$5,$6,'requested',$7,$8) on conflict(idempotency_key) do nothing returning id`, [id,organizationId,input.productId,input.fromLocationId,input.toLocationId,input.quantity,input.idempotencyKey,input.userId]);
  if(inserted[0]) return { id: inserted[0].id, existing:false };
  const existing=await sql.query<{id:string;organization_id:string;product_id:string;from_location_id:string;to_location_id:string;quantity:number;requested_by:string|null}>(`select id,organization_id,product_id,from_location_id,to_location_id,quantity,requested_by from enterprise_inventory_transfers where idempotency_key=$1`,[input.idempotencyKey]);
  const row=existing[0];
  if(!row) throw new Error("Inventory transfer idempotency conflict");
  if(row.organization_id!==organizationId || row.product_id!==input.productId || row.from_location_id!==input.fromLocationId || row.to_location_id!==input.toLocationId || Number(row.quantity)!==input.quantity || row.requested_by!==input.userId) throw new Error("Inventory transfer idempotency key reused with different operation");
  return { id: row.id, existing:true };
}

export async function receiveEnterpriseInventoryTransfer(input: { merchantId: string; transferId: string; userId: string }) {
  await requireRoleForUserId(["customer","merchant","admin"],input.userId);
  const organizationId=await getEnterpriseOrganizationId(input.merchantId);
  const sql = await getSql();
  const transfer=await sql.query<{to_location_id:string}>(`select to_location_id from enterprise_inventory_transfers where id=$1 and organization_id=$2`,[input.transferId,organizationId]);
  if(!transfer[0]) throw new Error("Inventory transfer not found");
  await requireEnterpriseLocationRoles(input.userId,transfer[0].to_location_id,["operations_manager","location_manager","warehouse_operator","inventory_manager"]);
  await sql.query(`select receive_enterprise_inventory_transfer($1,$2,$3)`, [organizationId, input.transferId, input.userId]);
  return { status: "received" as const };
}

export async function listEnterpriseIntegrations(merchantId: string, userId: string) {
  const organizationId = await requireEnterpriseOrgRoles(merchantId,userId,["operations_manager","analyst"]);
  const sql = await getSql();
  return sql.query(`select id,integration_type,provider_key,display_name,status,location_id,last_success_at,last_failure_at,created_at,updated_at from enterprise_integrations where organization_id=$1 order by display_name`, [organizationId]);
}

export async function createEnterpriseServiceCase(input: {
  merchantId: string;
  userId: string;
  customerUserId: string;
  orderId?: string;
  orderItemId?: number;
  productId?: string;
  serialUnitId?: string;
  serviceLocationId?: string;
  caseType: "warranty" | "repair" | "replacement" | "installation" | "inspection" | "recall";
  priority?: "low" | "normal" | "high" | "urgent";
  issueSummary: string;
}) {
  await requireRoleForUserId(["customer","merchant","admin"],input.userId);
  const organizationId=await getEnterpriseOrganizationId(input.merchantId);
  if(input.serviceLocationId) await requireEnterpriseLocationRoles(input.userId,input.serviceLocationId,["operations_manager","location_manager","support_manager"]);
  else await requireEnterpriseOrgRoles(input.merchantId,input.userId,["operations_manager","support_manager"]);
  const sql = await getSql();
  const id = `svc_${randomUUID().replaceAll("-", "")}`;
  await sql.query(
    `insert into enterprise_service_cases(id,organization_id,customer_user_id,order_id,order_item_id,product_id,serial_unit_id,service_location_id,case_type,priority,issue_summary)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, organizationId, input.customerUserId, input.orderId ?? null, input.orderItemId ?? null, input.productId ?? null, input.serialUnitId ?? null, input.serviceLocationId ?? null, input.caseType, input.priority ?? "normal", input.issueSummary.trim()],
  );
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
    "enterprise.service_case.created", "enterprise_service_case", id, input.userId, "merchant", null, "success",
    JSON.stringify({ organizationId, caseType: input.caseType, priority: input.priority ?? "normal" }),
  ]);
  return { id };
}


export async function listEnterpriseStaff(merchantId:string,userId:string):Promise<EnterpriseStaffRow[]>{
  const organizationId=await requireEnterpriseAdmin(merchantId,userId);
  const sql=await getSql();
  return sql.query<EnterpriseStaffRow>(`
    select s.id,s.user_id,u.name,u.email,s.location_id,l.name as location_name,s.role,s.status,s.created_at::text,s.updated_at::text
      from enterprise_location_staff s
      join "user" u on u.id=s.user_id
      left join merchant_inventory_locations l on l.id=s.location_id
     where s.organization_id=$1
     order by case s.role when 'enterprise_admin' then 0 else 1 end,u.name,s.role,l.name nulls first`,[organizationId]);
}

export async function setEnterpriseStaffAssignment(input:{merchantId:string;actorUserId:string;targetEmail:string;locationId?:string|null;role:EnterpriseStaffRole;status:"active"|"suspended"|"revoked"}){
  const organizationId=await requireEnterpriseAdmin(input.merchantId,input.actorUserId);
  const sql=await getSql();
  const rows=await sql.query<{result:{assignmentId:string;userId:string;role:EnterpriseStaffRole;status:string;locationId:string|null}}>(
    `with identity as (select set_config('app.user_id',$1,true) as user_id)
     select manage_enterprise_staff_assignment($1,$2,$3,$4,$5,$6) as result from identity`,
    [input.actorUserId,organizationId,input.targetEmail.trim(),input.locationId??null,input.role,input.status],
  );
  return rows[0]?.result;
}
