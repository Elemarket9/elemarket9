// Admin order management on REAL PostgreSQL (migration 0231): search filters,
// the read-only order timeline, append-only internal notes, the admin
// cancellation of unpaid orders (stock released, paid orders refused), the
// delivery hold shared with the support desk, contact reveal auditing, and the
// SQL-level guards that hold even if application code is bypassed.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test node --test tests/admin-orders.postgres.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { checkout, configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";
import { deliverWithRiderOtp } from "../scripts/helpers/delivery-fixture.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
let db, harness, sql, provider, payments, handlePaymentWebhook, server, pure, holds, event = 61_000;
const admin = `ao_admin_${randomBytes(4).toString("hex")}`;
const suspended = `ao_susp_${randomBytes(4).toString("hex")}`;

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url });
  provider = installPaymentProviderMock();
  harness = await startHarness();
  sql = harness.sql;
  payments = await harness.load("/src/modules/payments/public/payment.server.ts");
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));
  server = await harness.load("/src/modules/administration/internal/admin-orders.server.ts");
  pure = await harness.load("/src/modules/administration/internal/admin-orders.ts");
  holds = await harness.load("/src/modules/support/public/delivery-hold.server.ts");
  for (const [id, status] of [[admin, "active"], [suspended, "suspended"]]) {
    await sql.query(`insert into "user"(id,name,email,"emailVerified",role) values($1,$2,$3,true,'admin')`, [id, `Admin ${id}`, `${id}@example.test`]);
    await sql.query(`insert into admin_staff_roles(user_id,staff_role,status) values($1,'operations',$2)`, [id, status]);
  }
});
after(async () => {
  if (!enabled) return;
  provider?.restore();
  await harness?.close();
  await db?.drop();
});

const search = (input) => server.searchAdminOrders(pure.normalizeAdminOrderSearch(input));
/** Run `select <fn>` with app.user_id set (the CTE must be referenced to execute). */
const asActor = (actor, call, params) => sql.query(`with identity as (select set_config('app.user_id',$1,true)) select ${call} from identity`, [actor, ...params]);

/** A fresh merchant/customer whose fixture order is still awaiting payment (one unit reserved). */
async function unpaid() {
  return seedOrder(sql);
}
/** Paid through the simulated provider webhook, then (optionally) delivered with rider OTP. */
async function paid({ deliver = false, wallet = false } = {}) {
  const seed = await seedOrder(sql);
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
  if (wallet) await sql.query(`select wallet_enable_for_merchant($1,'admin_sim')`, [seed.merchant]);
  await sql.query(`update product_variants set stock=10 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=10 where id=$1`, [seed.product]);
  const order = await checkout(sql, seed);
  const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: seed.user });
  provider.pay(intent.providerReference);
  const raw = JSON.stringify({ event: "charge.success", data: { id: event++, reference: intent.providerReference, amount: Math.round(Number(order.grandTotal) * 100), currency: "GHS" } });
  await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
  if (deliver) await deliverWithRiderOtp(sql, { orderId: order.orderId });
  const [row] = await sql.query(`select status from orders where id=$1`, [order.orderId]);
  return { seed, orderId: order.orderId, status: row.status };
}

test("search: order ID (full and last 8), email, phone, merchant, status, dates; masked contact; newest first", { skip }, async () => {
  const a = await unpaid();
  const b = await unpaid();
  const ids = (r) => r.orders.map((o) => o.id);

  assert.deepEqual(ids(await search({ orderId: a.order })), [a.order]);
  assert.ok(ids(await search({ orderId: a.order.slice(-8) })).includes(a.order));
  assert.ok(ids(await search({ orderId: a.order.slice(-8).toUpperCase() })).includes(a.order), "suffix typed in capitals still matches a lowercase ID");

  const byEmail = await search({ email: `  ${a.user.toUpperCase()}@INTEGRATION.TEST ` });
  assert.deepEqual(ids(byEmail), [a.order], "email is exact, case-insensitive");
  assert.equal(byEmail.orders[0].customerEmailMasked.includes(a.user), false, "list shows masked email only");
  assert.match(byEmail.orders[0].customerEmailMasked, /^i•••.@integration\.test$/);
  assert.ok(!("customerEmail" in byEmail.orders[0]) && !("customerPhone" in byEmail.orders[0]));

  const local = `0${a.phone.slice(4, 6)} ${a.phone.slice(6, 9)} ${a.phone.slice(9)}`;
  const byPhone = await search({ phone: local });
  assert.deepEqual(ids(byPhone), [a.order], "local phone format is normalized to +233");
  assert.equal(byPhone.orders[0].customerPhoneMasked, `+233•••••${a.phone.slice(-4)}`);

  assert.deepEqual(ids(await search({ merchant: b.merchant })), [b.order], "merchant by ID");
  const byName = ids(await search({ merchant: "integration merch", limit: 50 }));
  assert.ok(byName.includes(a.order) && byName.includes(b.order), "merchant name contains, case-insensitive");
  assert.deepEqual(ids(await search({ merchant: "%_" })), [], "wildcards are literal");

  assert.deepEqual(ids(await search({ merchant: a.merchant, status: "payment_pending" })), [a.order]);
  assert.deepEqual(ids(await search({ merchant: a.merchant, status: "paid" })), []);

  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(ids(await search({ merchant: a.merchant, from: today, to: today })), [a.order]);
  assert.deepEqual(ids(await search({ merchant: a.merchant, from: "2020-01-01", to: "2020-01-31" })), []);

  const newest = await search({ limit: 50 });
  for (let i = 1; i < newest.orders.length; i++) assert.ok(newest.orders[i - 1].createdAt >= newest.orders[i].createdAt, "newest first");
  assert.ok(ids(newest).indexOf(b.order) < ids(newest).indexOf(a.order));
});

test("search: keyset pages never repeat or skip and are capped at 50", { skip }, async () => {
  for (let i = 0; i < 3; i++) await unpaid();
  const seen = [];
  let cursor;
  do {
    const page = await search({ limit: 2, cursor });
    assert.ok(page.orders.length <= 2);
    seen.push(...page.orders.map((o) => o.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const all = (await search({ limit: 50 })).orders.map((o) => o.id);
  assert.equal(new Set(seen).size, seen.length, "no repeats");
  assert.deepEqual(seen.slice(0, all.length), all, "same order as one big page");
  assert.throws(() => pure.normalizeAdminOrderSearch({ limit: 51 }));
});

test("timeline of a paid and delivered order is assembled from the real tables", { skip }, async () => {
  const { orderId, status, seed } = await paid({ deliver: true, wallet: true });
  assert.equal(status, "delivered");
  await server.addAdminOrderNote({ orderId, adminId: admin, body: "Customer called to confirm delivery" });
  const detail = await server.getAdminOrderDetail(orderId);
  assert.equal(detail.order.status, "delivered");
  assert.equal(detail.payment.status, "completed");
  assert.equal(Number(detail.order.grandTotal), Number(detail.order.productTotal) + Number(detail.order.deliveryTotal));
  assert.ok(detail.order.merchantNet && detail.order.platformFee, "merchant net and platform fee are shown");
  assert.equal(detail.items.length, 1);
  assert.equal(detail.merchant.id, seed.merchant);
  assert.ok(!detail.customer.emailMasked.includes(seed.user), "detail shows masked email by default");
  assert.ok(!JSON.stringify(detail).includes(seed.phone), "no full phone anywhere in the detail");

  const titles = detail.timeline.map((e) => e.title);
  const kinds = new Set(detail.timeline.map((e) => e.kind));
  assert.equal(titles[0], "Order placed");
  for (const kind of ["order", "payment", "delivery", "handover", "wallet", "note"]) assert.ok(kinds.has(kind), `timeline has ${kind}: ${titles.join(" | ")}`);
  assert.ok(titles.some((t) => /^Payment attempt #1/.test(t)), "payment attempts");
  assert.ok(titles.includes("Delivered (provider report)"));
  assert.ok(titles.includes("Handover verified with customer"));
  assert.ok(titles.some((t) => t.startsWith("Merchant wallet: sale")), "wallet ledger entry for the sale");
  assert.ok(detail.timeline.some((e) => e.kind === "audit" && e.title === "admin.order.note_added"), "audit events for the order");
  for (let i = 1; i < detail.timeline.length; i++) assert.ok(detail.timeline[i - 1].at <= detail.timeline[i].at, "chronological");
  assert.deepEqual(detail.actions, { cancelUnpaid: false, requestRefund: true, placeHold: false, releaseHold: false });
});

test("internal notes are append-only and length-checked", { skip }, async () => {
  const { order } = await unpaid();
  const { noteId } = await server.addAdminOrderNote({ orderId: order, adminId: admin, body: "  Called customer, no answer  " });
  const [note] = await sql.query(`select body, admin_id from admin_order_notes where id=$1`, [noteId]);
  assert.deepEqual(note, { body: "Called customer, no answer", admin_id: admin });
  await assert.rejects(sql.query(`update admin_order_notes set body='rewritten history' where id=$1`, [noteId]), /append-only/);
  await assert.rejects(sql.query(`delete from admin_order_notes where id=$1`, [noteId]), /append-only/);
  await assert.rejects(sql.query(`truncate admin_order_notes`), /append-only/);
  await assert.rejects(server.addAdminOrderNote({ orderId: order, adminId: admin, body: "ok" }), /3-2000/);
  await assert.rejects(server.addAdminOrderNote({ orderId: order, adminId: admin, body: "x".repeat(2001) }), /3-2000/);
  await assert.rejects(server.addAdminOrderNote({ orderId: "ord_missing_000", adminId: admin, body: "A valid note" }), /order not found/);
  await assert.rejects(sql.query(`insert into admin_order_notes(id,order_id,admin_id,body) values('n_short',$1,$2,'no')`, [order, admin]), /admin_order_notes_body_check/);
  const audit = await sql.query(`select actor_user_id, metadata from audit_events where event_type='admin.order.note_added' and resource_id=$1`, [order]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_user_id, admin);
  assert.equal(audit[0].metadata.noteId, noteId);
  assert.equal(audit[0].metadata.body, undefined, "note text is not copied into audit metadata");
});

test("cancelling an unpaid order releases its stock; a second cancel and a paid order are refused", { skip }, async () => {
  const seed = await unpaid();
  const [before] = await sql.query(`select stock from product_variants where id=$1`, [seed.variant]);
  const result = await server.cancelUnpaidOrderAsAdmin({ orderId: seed.order, adminId: admin, reason: "Customer asked by phone to cancel" });
  assert.deepEqual(result, { orderId: seed.order, status: "cancelled", releasedReservations: 1 });
  const [[order], [variant], reservations, audit] = await Promise.all([
    sql.query(`select status from orders where id=$1`, [seed.order]),
    sql.query(`select stock from product_variants where id=$1`, [seed.variant]),
    sql.query(`select status, released_at from order_stock_reservations where order_id=$1`, [seed.order]),
    sql.query(`select actor_user_id, metadata from audit_events where event_type='admin.order.cancelled' and resource_id=$1`, [seed.order]),
  ]);
  assert.equal(order.status, "cancelled");
  assert.equal(variant.stock, before.stock + 1, "reserved unit is back on sale");
  assert.ok(reservations.every((r) => r.status === "released" && r.released_at));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_user_id, admin);
  assert.equal(audit[0].metadata.releasedReservations, 1);

  await assert.rejects(server.cancelUnpaidOrderAsAdmin({ orderId: seed.order, adminId: admin, reason: "Clicked cancel a second time" }), /only orders awaiting payment/);
  const [again] = await sql.query(`select stock from product_variants where id=$1`, [seed.variant]);
  assert.equal(again.stock, variant.stock, "stock is not released twice");

  const paidOrder = await paid();
  assert.equal(paidOrder.status, "paid");
  await assert.rejects(server.cancelUnpaidOrderAsAdmin({ orderId: paidOrder.orderId, adminId: admin, reason: "Trying to cancel a paid order" }), /refunded through finance/);
  const [still] = await sql.query(`select o.status, p.status as payment from orders o join payments p on p.order_id=o.id where o.id=$1`, [paidOrder.orderId]);
  assert.deepEqual(still, { status: "paid", payment: "completed" });
});

test("delivery hold and release go through the function shared with the support desk", { skip }, async () => {
  const { orderId } = await paid();
  await server.setOrderDeliveryHoldAsAdmin({ orderId, adminId: admin, action: "hold", reason: "Possible account takeover, verify first" });
  let [hold] = await sql.query(`select active, placed_by, reason from order_delivery_holds where order_id=$1`, [orderId]);
  assert.deepEqual(hold, { active: true, placed_by: admin, reason: "Possible account takeover, verify first" });
  assert.equal((await server.getAdminOrderDetail(orderId)).actions.releaseHold, true);

  await server.setOrderDeliveryHoldAsAdmin({ orderId, adminId: admin, action: "release", reason: "Customer verified by call-back" });
  [hold] = await sql.query(`select active, released_by, release_reason from order_delivery_holds where order_id=$1`, [orderId]);
  assert.deepEqual(hold, { active: false, released_by: admin, release_reason: "Customer verified by call-back" });
  await assert.rejects(server.setOrderDeliveryHoldAsAdmin({ orderId, adminId: admin, action: "release", reason: "Releasing a second time" }), /No active delivery hold/);

  // The support desk calls the very same function; only the audit event name differs.
  await holds.applyOrderDeliveryHold({ orderId, action: "hold", reason: "Support: customer reported fraud", actorId: admin, auditEventType: "support.delivery.hold" });
  [hold] = await sql.query(`select active, released_at from order_delivery_holds where order_id=$1`, [orderId]);
  assert.deepEqual(hold, { active: true, released_at: null });
  const events = await sql.query(`select event_type from audit_events where resource_type='order' and resource_id=$1 and event_type like '%delivery%' order by id`, [orderId]);
  assert.deepEqual(events.map((e) => e.event_type), ["admin.order.delivery_hold", "admin.order.delivery_release", "support.delivery.hold"]);

  const { order: pending } = await unpaid();
  await assert.rejects(server.setOrderDeliveryHoldAsAdmin({ orderId: pending, adminId: admin, action: "hold", reason: "Unpaid order cannot be held" }), /not eligible/);
  await assert.rejects(holds.applyOrderDeliveryHold({ orderId, action: "hold", reason: "short", actorId: admin, auditEventType: "x.y" }), /12-1000/);
});

test("revealing contact returns it once and audits it without copying the PII", { skip }, async () => {
  const seed = await unpaid();
  const contact = await server.revealAdminOrderContact({ orderId: seed.order, adminId: admin, reason: "Calling about failed payment" });
  assert.equal(contact.email, `${seed.user}@integration.test`);
  assert.equal(contact.accountPhone, seed.phone);
  const [audit] = await sql.query(`select actor_user_id, metadata from audit_events where event_type='admin.order.contact_revealed' and resource_id=$1`, [seed.order]);
  assert.equal(audit.actor_user_id, admin);
  assert.ok(!JSON.stringify(audit.metadata).includes(seed.user) && !JSON.stringify(audit.metadata).includes(seed.phone));
});

test("SQL guards: identity, active administrator, reason, open payment attempts", { skip }, async () => {
  const seed = await unpaid();
  const cancel = (actor, claimed, reason = "A valid cancellation reason") =>
    asActor(claimed, `admin_cancel_unpaid_order($2,$3,$4)`, [seed.order, actor, reason]);
  await assert.rejects(sql.query(`select admin_cancel_unpaid_order($1,$2,'A valid cancellation reason')`, [seed.order, admin]), /unauthorized/, "no session identity");
  await assert.rejects(cancel(admin, seed.user), /unauthorized/, "identity must be the actor");
  await assert.rejects(cancel(seed.user, seed.user), /admin role required/, "customers cannot use the admin path");
  await assert.rejects(cancel(suspended, suspended), /admin role required/, "suspended staff are refused");
  await assert.rejects(cancel(admin, admin, "too short"), /12-1000/);
  await assert.rejects(asActor(seed.user, `add_admin_order_note($1,$2,'Customer note attempt')`, [seed.order]), /admin role required/);
  await assert.rejects(sql.query(`select add_admin_order_note($1,$2,'No identity set')`, [admin, seed.order]), /unauthorized/);

  // A payment attempt in flight blocks cancellation exactly like the customer path.
  await sql.query(`insert into payment_attempts(id,payment_id,attempt_no,provider_key,amount,currency,status) values($1,$2,1,'paystack',115,'GHS','initiated')`,
    [`pa_${seed.order}`, seed.payment]);
  await assert.rejects(cancel(admin, admin), /being initialized or processed/);
  const [order] = await sql.query(`select status from orders where id=$1`, [seed.order]);
  assert.equal(order.status, "payment_pending");
});
