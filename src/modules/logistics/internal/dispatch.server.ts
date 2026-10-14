import { assertCommerceExecutionAllowed } from "@/lib/security/launch-profile.mjs";
import { getSql } from "@/lib/db";
import { isSharedEnvironment } from "@/lib/env.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";

/** Materialize durable provider-bound work for the partner portal. No carrier transmission. */
export async function dispatchDeliveries(limit = 25) {
  assertCommerceExecutionAllowed("delivery dispatch");
  const sql = await getSql();
  const token = crypto.randomUUID();
  const rows = await sql.query<{ order_id: string }>(
    `update delivery_dispatch_outbox set status='processing',lease_token=$1,lease_until=now()+interval '2 minutes',attempt_count=attempt_count+1,updated_at=now()
    where order_id in (select order_id from delivery_dispatch_outbox where (status='pending' or (status='processing' and lease_until<now())) and next_attempt_at<=now() order by created_at limit $2 for update skip locked) returning order_id`,
    [token, limit],
  );
  let assigned = 0;
  let attention = 0;
  for (const row of rows) {
    try {
      const jobs = await sql.query<{ id: string }>(
        `with eligible as (
        select o.id,q.provider_id from orders o join delivery_quotes q on q.id=o.delivery_quote_id and q.user_id=o.user_id and q.merchant_id=o.merchant_id
        join delivery_providers p on p.id=q.provider_id and p.status='active'
        join delivery_dispatch_outbox d on d.order_id=o.id and d.lease_token=$2 and d.status='processing'
        where o.id=$1 and o.status in ('paid','confirmed','fulfilling') and (not $3::boolean or p.environment='production') for update of o
      ), job as (
        insert into delivery_jobs(id,order_id,provider_id) select 'dj_'||id,id,provider_id from eligible
        on conflict(order_id) do update set order_id=excluded.order_id returning id,provider_id
      ) select job.id from job join eligible on job.provider_id=eligible.provider_id`,
        [row.order_id, token, isSharedEnvironment()],
      );
      if (!jobs[0])
        throw new Error("Order or purchased quote provider is unavailable; review required");
      await sql.query(
        `update delivery_dispatch_outbox set status='manual',lease_token=null,lease_until=null,last_error=null,updated_at=now() where order_id=$1 and lease_token=$2 and status='processing'`,
        [row.order_id, token],
      );
      assigned++;
    } catch (error) {
      attention++;
      await sql.query(
        `update delivery_dispatch_outbox set status=case when attempt_count>=8 then 'needs_attention' else 'pending' end,next_attempt_at=now()+least(3600,power(2,attempt_count)::integer*30)*interval '1 second',last_error=$3,lease_token=null,lease_until=null,updated_at=now() where order_id=$1 and lease_token=$2 and status='processing'`,
        [
          row.order_id,
          token,
          error instanceof Error ? error.message.slice(0, 500) : "Assignment failed",
        ],
      );
    }
  }
  return { scanned: rows.length, assigned, attention };
}

/** Admin retries local assignment; the purchased quote determines the carrier. */
export async function assignDeliveryManually(orderId: string) {
  const userId = await requireFreshSession();
  await requireAdminForUserId(userId);
  const sql = await getSql();
  await sql.query(
    `insert into delivery_dispatch_outbox(order_id) select id from orders where id=$1 and status in ('paid','confirmed','fulfilling') and delivery_quote_id is not null on conflict(order_id) do update set status='pending',next_attempt_at=now(),updated_at=now() where delivery_dispatch_outbox.status in ('needs_attention','pending')`,
    [orderId],
  );
  await dispatchDeliveries(25);
  const jobs = await sql.query<{ id: string }>(
    `select j.id from delivery_jobs j join orders o on o.id=j.order_id join delivery_quotes q on q.id=o.delivery_quote_id and q.provider_id=j.provider_id where o.id=$1 and o.status in ('paid','confirmed','fulfilling')`,
    [orderId],
  );
  if (!jobs[0])
    throw new Error("Assignment is pending or order has no eligible provider-bound quote");
  await sql.query(
    `insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome) select p.partner_organization_id,$2,'delivery.manual_assignment','delivery_job',j.id,'success' from delivery_jobs j join delivery_providers p on p.id=j.provider_id where j.id=$1 and p.partner_organization_id is not null`,
    [jobs[0].id, userId],
  );
  return { jobId: jobs[0].id };
}
