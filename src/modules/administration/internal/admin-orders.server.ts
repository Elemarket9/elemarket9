import { getSql, withTransaction } from "@/lib/db";
import { applyOrderDeliveryHold, type OrderDeliveryHoldAction } from "@/modules/support/public/delivery-hold.server";
import {
  buildOrderTimeline, maskEmail, maskPhone, orderActionAvailability,
  type NormalizedAdminOrderSearch, type OrderTimelineEntry, type OrderTimelineSources,
} from "./admin-orders";

/**
 * Admin order workspace, server side. Permission-free by design: the transport
 * layer (transport/admin/orders.functions.ts) authorizes, checks the session
 * and rate-limits before calling anything here.
 *
 * PII rule: search results and the order detail carry MASKED email/phone only.
 * Full contact leaves the server only through revealAdminOrderContact(), which
 * writes an audit event in the same transaction.
 */

export type AdminOrderListRow = {
  id: string; status: string; currency: string; grandTotal: string; createdAt: string;
  merchantId: string; merchantName: string; customerName: string | null;
  customerEmailMasked: string | null; customerPhoneMasked: string | null;
  paymentStatus: string | null; paymentTiming: string; holdActive: boolean;
};

const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** One query, no per-row lookups. Each active filter can use an index. */
export async function searchAdminOrders(f: NormalizedAdminOrderSearch): Promise<{ orders: AdminOrderListRow[]; nextCursor: string | null }> {
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = [];
  if (f.orderId) where.push(`o.id = ${p(f.orderId)}`);
  if (f.orderSuffix) { const s = p(f.orderSuffix); where.push(`right(o.id, 8) in (${s}, lower(${s}))`); }
  if (f.email) where.push(`o.user_id in (select u2.id from "user" u2 where lower(u2.email) = ${p(f.email)})`);
  if (f.phone) {
    // Delivery contact on the order OR the customer's account phone. A union of
    // two index lookups; an OR here would scan every order.
    const ph = p(f.phone);
    where.push(`o.id in (select o3.id from orders o3 where o3.delivery_contact_phone = ${ph}
                         union all select o4.id from profiles pr4 join orders o4 on o4.user_id = pr4.user_id where pr4.phone = ${ph})`);
  }
  if (f.merchantId && f.merchantNameLike) {
    where.push(`o.merchant_id in (select m2.id from merchants m2 where m2.id = ${p(f.merchantId)} or m2.name ilike ${p(f.merchantNameLike)} escape '\\')`);
  }
  if (f.status) where.push(`o.status = ${p(f.status)}`);
  if (f.createdFrom) where.push(`o.created_at >= ${p(f.createdFrom)}::timestamptz`);
  if (f.createdBefore) where.push(`o.created_at < ${p(f.createdBefore)}::timestamptz`);
  if (f.cursor) where.push(`(o.created_at, o.id) < (${p(f.cursor.at)}::timestamptz, ${p(f.cursor.id)})`);
  const limit = Math.min(Math.max(1, f.limit), 50);
  const rows = await (await getSql()).query<{
    id: string; status: string; currency: string; grand_total: string; created_at: string; cursor_at: string;
    merchant_id: string; merchant_name: string; customer_name: string | null; email: string | null; phone: string | null;
    payment_status: string | null; payment_timing: string; hold_active: boolean;
  }>(
    `select o.id, o.status, o.currency, o.grand_total::text as grand_total,
            to_char(o.created_at at time zone 'UTC', ${ISO_US}) as cursor_at, o.created_at,
            o.merchant_id, m.name as merchant_name, u.name as customer_name, u.email,
            coalesce(o.delivery_contact_phone, pr.phone) as phone,
            pay.status as payment_status, o.payment_timing, coalesce(h.active, false) as hold_active
       from orders o
       join merchants m on m.id = o.merchant_id
       left join "user" u on u.id = o.user_id
       left join profiles pr on pr.user_id = o.user_id
       left join payments pay on pay.order_id = o.id
       left join order_delivery_holds h on h.order_id = o.id and h.active
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by o.created_at desc, o.id desc
      limit ${p(limit + 1)}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    orders: page.map((r) => ({
      id: r.id, status: r.status, currency: r.currency.trim(), grandTotal: r.grand_total, createdAt: r.cursor_at,
      merchantId: r.merchant_id, merchantName: r.merchant_name, customerName: r.customer_name,
      customerEmailMasked: maskEmail(r.email), customerPhoneMasked: maskPhone(r.phone),
      paymentStatus: r.payment_status, paymentTiming: r.payment_timing, holdActive: Boolean(r.hold_active),
    })),
    nextCursor: rows.length > limit && last ? `${last.cursor_at}|${last.id}` : null,
  };
}

export type AdminOrderDetail = {
  order: {
    id: string; status: string; currency: string; paymentTiming: string; createdAt: string; updatedAt: string;
    productTotal: string; promoDiscount: string; deliveryTotal: string; platformFee: string; merchantNet: string; grandTotal: string;
    deliveryTier: string; address: string;
  };
  customer: { id: string; name: string | null; emailMasked: string | null; phoneMasked: string | null };
  merchant: { id: string; name: string; status: string; city: string | null };
  items: Array<{ id: string; productId: string; productName: string; variantId: string | null; variantName: string | null; quantity: number; unitPrice: string; productTotal: string }>;
  payment: { id: string; status: string; method: string; amount: string } | null;
  hold: { active: boolean; reason: string; placedAt: string } | null;
  actions: ReturnType<typeof orderActionAvailability>;
  timeline: OrderTimelineEntry[];
};

const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export async function getAdminOrderDetail(orderId: string): Promise<AdminOrderDetail | null> {
  const sql = await getSql();
  const [order] = await sql.query<{
    id: string; status: string; currency: string; payment_timing: string; created_at: Date; updated_at: Date;
    product_total: string; promo_discount: string; delivery_total: string; platform_fee: string; merchant_net: string; grand_total: string;
    delivery_tier: string; address: string; user_id: string; customer_name: string | null; profile_name: string | null; email: string | null; phone: string | null;
    merchant_id: string; merchant_name: string; merchant_status: string; merchant_city: string | null;
  }>(
    `select o.id, o.status, o.currency, o.payment_timing, o.created_at, o.updated_at,
            o.product_total::text as product_total, o.promo_discount::text as promo_discount, o.delivery_total::text as delivery_total,
            o.platform_fee::text as platform_fee, o.merchant_net::text as merchant_net, o.grand_total::text as grand_total,
            o.delivery_tier, o.address, o.user_id, u.name as customer_name, pr.name as profile_name, u.email,
            coalesce(o.delivery_contact_phone, pr.phone) as phone,
            o.merchant_id, m.name as merchant_name, m.status as merchant_status, m.city as merchant_city
       from orders o join merchants m on m.id = o.merchant_id
       left join "user" u on u.id = o.user_id left join profiles pr on pr.user_id = o.user_id
      where o.id = $1`, [orderId]);
  if (!order) return null;

  const id = order.id;
  // Independent, bounded reads; every source is keyed by this order (no N+1).
  const [items, payments, attempts, transitions, refunds, returns, jobs, handovers, holds, shipments, disputes, wallet, history, audit, notes] = await Promise.all([
    sql.query<{ id: string; product_id: string; product_name: string; variant_id: string | null; variant_name: string | null; quantity: number; unit_price: string; product_total: string }>(
      `select oi.id::text as id, oi.product_id, coalesce(p.name, oi.product_id) as product_name, oi.variant_id, coalesce(v.name, v.sku) as variant_name,
              oi.quantity, oi.unit_price::text as unit_price, oi.product_total::text as product_total
         from order_items oi left join products p on p.id = oi.product_id left join product_variants v on v.id = oi.variant_id
        where oi.order_id = $1 order by oi.id limit 100`, [id]),
    sql.query<{ id: string; status: string; method: string; amount: string; created_at: Date }>(
      `select id, status, method, amount::text as amount, created_at from payments where order_id = $1 order by created_at limit 10`, [id]),
    sql.query<{ attempt_no: number; status: string; provider_key: string; failure_code: string | null; created_at: Date }>(
      `select a.attempt_no, a.status, a.provider_key, a.failure_code, a.created_at
         from payment_attempts a join payments p on p.id = a.payment_id where p.order_id = $1 order by a.created_at limit 50`, [id]),
    sql.query<{ from_status: string | null; to_status: string; source: string | null; created_at: Date }>(
      `select t.from_status, t.to_status, t.source, t.created_at
         from payment_state_transitions t join payments p on p.id = t.payment_id where p.order_id = $1 order by t.created_at limit 100`, [id]),
    sql.query<{ requested_at: Date; processed_at: Date | null; status: string; amount: string; reason: string | null; requested_by: string | null }>(
      `select r.requested_at, r.processed_at, r.status, r.amount::text as amount, r.reason, coalesce(u.name, r.requested_by) as requested_by
         from provider_refund_requests r left join "user" u on u.id = r.requested_by where r.order_id = $1 order by r.requested_at limit 50`, [id]),
    sql.query<{ id: string; created_at: Date; received_at: Date | null; closed_at: Date | null; status: string; reason_code: string; quantity: number; resolution_type: string | null }>(
      `select id, created_at, received_at, closed_at, status, reason_code, quantity, resolution_type
         from return_requests where order_id = $1 order by created_at limit 50`, [id]),
    sql.query<{
      provider_name: string | null; status: string; failure_reason: string | null; assigned_at: Date | null; accepted_at: Date | null; picked_up_at: Date | null;
      in_transit_at: Date | null; delivered_at: Date | null; failed_at: Date | null; return_requested_at: Date | null; returned_at: Date | null;
    }>(
      `select dp.name as provider_name, j.status, j.failure_reason, j.assigned_at, j.accepted_at, j.picked_up_at, j.in_transit_at,
              j.delivered_at, j.failed_at, j.return_requested_at, j.returned_at
         from delivery_jobs j left join delivery_providers dp on dp.id = j.provider_id where j.order_id = $1 order by j.assigned_at limit 20`, [id]),
    sql.query<{ verified_at: Date | null; verification_method: string | null; verified_by: string | null }>(
      `select h.verified_at, h.verification_method, coalesce(u.name, h.verified_by) as verified_by
         from order_delivery_handover h left join "user" u on u.id = h.verified_by where h.order_id = $1 order by h.issued_at limit 20`, [id]),
    sql.query<{ active: boolean; reason: string; placed_at: Date; placed_by: string | null; released_at: Date | null; release_reason: string | null; released_by: string | null }>(
      `select h.active, h.reason, h.placed_at, coalesce(pu.name, h.placed_by) as placed_by, h.released_at, h.release_reason, coalesce(ru.name, h.released_by) as released_by
         from order_delivery_holds h left join "user" pu on pu.id = h.placed_by left join "user" ru on ru.id = h.released_by where h.order_id = $1`, [id]),
    sql.query<{ shipped_at: Date | null; delivered_at: Date | null; carrier: string | null; status: string }>(
      `select shipped_at, delivered_at, carrier, status from shipments where order_id = $1 order by created_at limit 20`, [id]),
    sql.query<{ created_at: Date; status: string; resolved_at: Date | null }>(
      `select created_at, status, resolved_at from customer_order_disputes where order_id = $1 order by created_at limit 20`, [id]),
    sql.query<{ created_at: Date; entry_type: string; bucket: string; amount: string }>(
      `select created_at, entry_type, bucket, amount::text as amount from wallet_ledger_entries where order_id = $1 order by created_at, id limit 100`, [id]),
    sql.query<{ created_at: Date; from_status: string | null; to_status: string; note: string | null; actor: string | null }>(
      `select h.created_at, h.from_status, h.to_status, h.note, coalesce(u.name, h.actor_user_id) as actor
         from merchant_order_status_history h left join "user" u on u.id = h.actor_user_id where h.order_id = $1 order by h.created_at limit 100`, [id]),
    // Audit evidence about this order, its payment and its returns. Metadata is
    // never sent whole; only a short "reason" string when present.
    sql.query<{ created_at: Date; event_type: string; actor: string | null; outcome: string; reason: string | null }>(
      `select a.created_at, a.event_type, coalesce(u.name, a.actor_user_id, a.actor_role) as actor, a.outcome,
              case when jsonb_typeof(a.metadata->'reason') = 'string' then left(a.metadata->>'reason', 300) end as reason
         from audit_events a left join "user" u on u.id = a.actor_user_id
        where (a.resource_type = 'order' and a.resource_id = $1)
           or (a.resource_type = 'payment' and a.resource_id in (select id from payments where order_id = $1))
           or (a.resource_type = 'return_request' and a.resource_id in (select id from return_requests where order_id = $1))
        order by a.created_at, a.id limit 200`, [id]),
    sql.query<{ created_at: Date; body: string; actor: string | null }>(
      `select n.created_at, n.body, coalesce(u.name, n.admin_id) as actor
         from admin_order_notes n left join "user" u on u.id = n.admin_id where n.order_id = $1 order by n.created_at, n.id limit 200`, [id]),
  ]);

  const sources: OrderTimelineSources = {
    order: { createdAt: order.created_at, status: order.status },
    statusHistory: history.map((h) => ({ at: h.created_at, fromStatus: h.from_status, toStatus: h.to_status, note: h.note, actor: h.actor })),
    payments: payments.map((pm) => ({ id: pm.id, at: pm.created_at, method: pm.method, status: pm.status, amount: pm.amount })),
    paymentTransitions: transitions.map((t) => ({ at: t.created_at, fromStatus: t.from_status, toStatus: t.to_status, source: t.source })),
    paymentAttempts: attempts.map((a) => ({ at: a.created_at, attemptNo: Number(a.attempt_no), status: a.status, providerKey: a.provider_key, failureCode: a.failure_code })),
    refunds: refunds.map((r) => ({ requestedAt: r.requested_at, processedAt: r.processed_at, status: r.status, amount: r.amount, reason: r.reason, requestedBy: r.requested_by })),
    returns: returns.map((r) => ({ at: r.created_at, receivedAt: r.received_at, closedAt: r.closed_at, status: r.status, reasonCode: r.reason_code, quantity: Number(r.quantity), resolutionType: r.resolution_type })),
    deliveryJobs: jobs.map((j) => ({
      providerName: j.provider_name, status: j.status, failureReason: j.failure_reason, assignedAt: j.assigned_at, acceptedAt: j.accepted_at,
      pickedUpAt: j.picked_up_at, inTransitAt: j.in_transit_at, deliveredAt: j.delivered_at, failedAt: j.failed_at,
      returnRequestedAt: j.return_requested_at, returnedAt: j.returned_at,
    })),
    handovers: handovers.map((h) => ({ verifiedAt: h.verified_at, method: h.verification_method, verifiedBy: h.verified_by })),
    holds: holds.map((h) => ({ placedAt: h.placed_at, reason: h.reason, placedBy: h.placed_by, releasedAt: h.released_at, releaseReason: h.release_reason, releasedBy: h.released_by, active: h.active })),
    shipments: shipments.map((s) => ({ shippedAt: s.shipped_at, deliveredAt: s.delivered_at, carrier: s.carrier, status: s.status })),
    disputes: disputes.map((d) => ({ at: d.created_at, status: d.status, resolvedAt: d.resolved_at })),
    wallet: wallet.map((w) => ({ at: w.created_at, entryType: w.entry_type, bucket: w.bucket, amount: w.amount })),
    audit: audit.map((a) => ({ at: a.created_at, eventType: a.event_type, actor: a.actor, outcome: a.outcome, reason: a.reason })),
    notes: notes.map((n) => ({ at: n.created_at, body: n.body, actor: n.actor })),
  };

  const payment = payments[payments.length - 1] ?? null;
  const hold = holds[0] ?? null;
  return {
    order: {
      id, status: order.status, currency: order.currency.trim(), paymentTiming: order.payment_timing,
      createdAt: toIso(order.created_at), updatedAt: toIso(order.updated_at),
      productTotal: order.product_total, promoDiscount: order.promo_discount, deliveryTotal: order.delivery_total,
      platformFee: order.platform_fee, merchantNet: order.merchant_net, grandTotal: order.grand_total,
      deliveryTier: order.delivery_tier, address: order.address,
    },
    customer: { id: order.user_id, name: order.profile_name ?? order.customer_name, emailMasked: maskEmail(order.email), phoneMasked: maskPhone(order.phone) },
    merchant: { id: order.merchant_id, name: order.merchant_name, status: order.merchant_status, city: order.merchant_city },
    items: items.map((i) => ({ id: i.id, productId: i.product_id, productName: i.product_name, variantId: i.variant_id, variantName: i.variant_name, quantity: Number(i.quantity), unitPrice: i.unit_price, productTotal: i.product_total })),
    payment: payment ? { id: payment.id, status: payment.status, method: payment.method, amount: payment.amount } : null,
    hold: hold ? { active: hold.active, reason: hold.reason, placedAt: toIso(hold.placed_at) } : null,
    actions: orderActionAvailability({ status: order.status, paymentStatus: payment?.status ?? null, holdActive: Boolean(hold?.active) }),
    timeline: buildOrderTimeline(sources),
  };
}

/** Append-only note; the SQL function re-checks the actor and writes the audit. */
export async function addAdminOrderNote(input: { orderId: string; adminId: string; body: string }) {
  return withTransaction(async (tx) => {
    const rows = await tx.query<{ result: { noteId: string; orderId: string } }>(
      `with identity as (select set_config('app.user_id', $1, true)) select add_admin_order_note($1, $2, $3) as result from identity`,
      [input.adminId, input.orderId, input.body]);
    return rows[0]!.result;
  });
}

/** Unpaid orders only; releases stock reservations. Paid orders are refused by SQL. */
export async function cancelUnpaidOrderAsAdmin(input: { orderId: string; adminId: string; reason: string }) {
  return withTransaction(async (tx) => {
    const rows = await tx.query<{ result: { orderId: string; status: "cancelled"; releasedReservations: number } }>(
      `with identity as (select set_config('app.user_id', $1, true)) select admin_cancel_unpaid_order($2, $1, $3) as result from identity`,
      [input.adminId, input.orderId, input.reason]);
    return rows[0]!.result;
  });
}

/** Same shared transaction as the support desk; recorded as an order-desk action. */
export async function setOrderDeliveryHoldAsAdmin(input: { orderId: string; adminId: string; action: OrderDeliveryHoldAction; reason: string }) {
  return applyOrderDeliveryHold({
    orderId: input.orderId, action: input.action, reason: input.reason, actorId: input.adminId,
    auditEventType: `admin.order.delivery_${input.action}`,
  });
}

/** Returns the unmasked contact once, audited in the same transaction. */
export async function revealAdminOrderContact(input: { orderId: string; adminId: string; reason: string }) {
  return withTransaction(async (tx) => {
    const [row] = await tx.query<{ email: string | null; phone: string | null; delivery_phone: string | null }>(
      `select u.email, pr.phone, o.delivery_contact_phone as delivery_phone
         from orders o left join "user" u on u.id = o.user_id left join profiles pr on pr.user_id = o.user_id
        where o.id = $1`, [input.orderId]);
    if (!row) throw new Error("Order not found");
    await tx.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
      "admin.order.contact_revealed", "order", input.orderId, input.adminId, "admin", null, "success",
      JSON.stringify({ reason: input.reason, fields: ["email", "phone"] }),
    ]);
    return { email: row.email, phone: row.delivery_phone ?? row.phone, accountPhone: row.phone };
  });
}
