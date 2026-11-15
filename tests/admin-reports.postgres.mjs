// Back-office reports on REAL PostgreSQL: a known set of orders is placed and
// paid through the real checkout, payment webhook, refund and rider-OTP handover
// paths, then every headline number of /admin/reports is asserted exactly.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test node --test tests/admin-reports.postgres.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";
import { deliverWithRiderOtp } from "../scripts/helpers/delivery-fixture.mjs";
import { quoteCartCanonical } from "../src/lib/commerce-guards.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
let db, harness, sql, payments, reports, handlePaymentWebhook, provider, event = 120_000;
const NOW = Date.now();
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const RANGE = { from: day(NOW - 3 * DAY), to: day(NOW) };
const paidAt = {};
let A, B, buyer2;

/** Real create_pending_order() for `quantity` units of the seed product. */
async function place(seed, quantity = 1, buyer = seed) {
  const tag = Math.random().toString(36).slice(2, 10);
  const address = "1 Test Street";
  const items = [{ productId: seed.product, variantId: seed.variant, quantity }];
  const fingerprint = createHash("sha256")
    .update(quoteCartCanonical({ merchantId: seed.merchant, address, tier: "same_day", items })).digest("hex");
  const quoteId = `${seed.quote}_${tag}`;
  await sql.query(
    `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,expires_at)
     values($1,$2,$3,$4,'same_day',15,60,1,$5,now()+interval '1 hour')`,
    [quoteId, buyer.user, seed.merchant, fingerprint, address]);
  const [{ result }] = await sql.query(
    `with identity as (select set_config('app.user_id',$1,true) u)
     select create_pending_order($1,$2,$3,$4::jsonb,$5::jsonb,$6,'mobile_money',null) as result from identity`,
    [buyer.user, `${buyer.idem}_${tag}_0123`, createHash("sha256").update(tag).digest("hex"), JSON.stringify(items),
      JSON.stringify([{ merchantId: seed.merchant, quoteId }]), address]);
  return result.orders[0];
}

/** Pay through the simulated provider and the real webhook; the payment time is then pinned to `at`. */
async function pay(order, at) {
  const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: order.userId });
  provider.pay(intent.providerReference);
  const raw = JSON.stringify({ event: "charge.success", data: { id: event++, reference: intent.providerReference, amount: Math.round(Number(order.grandTotal) * 100), currency: "GHS" } });
  await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
  if (at !== undefined) {
    const rows = await sql.query(
      `update payment_state_transitions set created_at=$2 where payment_id=$1 and to_status='completed' returning id`,
      [order.paymentId, new Date(at).toISOString()]);
    assert.equal(rows.length, 1, "exactly one completion transition");
    paidAt[order.orderId] = at;
  }
  return intent.providerReference;
}

/** Provider refund lifecycle event through the real apply_payment_webhook. */
async function refundEvent(order, reference, type) {
  const status = type === "refund.processed" ? "refunded" : "completed";
  await sql.query(`select apply_payment_webhook('paystack',$1,$2,$3,$4,$5,'GHS',$6,$7)`,
    [`evt_${event++}`, type, reference, status, order.grandTotal, "h".repeat(64), `rf_${order.orderId}`]);
}

async function shop(name, category, rateBps) {
  const seed = await seedOrder(sql);
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]); // fixture checkout abandoned
  await sql.query(`update merchants set name=$2, category=$3, catalog_categories=ARRAY[$3] where id=$1`, [seed.merchant, name, category]);
  await sql.query(`update products set stock=100, category=$2 where id=$1`, [seed.product, category]);
  await sql.query(`update product_variants set stock=100 where id=$1`, [seed.variant]);
  if (rateBps !== null) await sql.query(`insert into commission_rules(scope_type,scope_id,rate_bps) values('merchant',$1,$2)`, [seed.merchant, rateBps]);
  return seed;
}

const withUser = (seed, o) => ({ ...o, userId: seed.user });

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url });
  provider = installPaymentProviderMock();
  harness = await startHarness();
  sql = harness.sql;
  payments = await harness.load("/src/modules/payments/public/payment.server.ts");
  reports = await harness.load("/src/modules/administration/internal/reports/admin-reports.server.ts");
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));

  A = await shop("Ama Electronics", "electronics", 1000); // 10% commission
  B = await shop("Kofi's 100% Fabrics", "fashion", null); // global 5% commission
  // Checkout allows 8 orders per customer per minute, so a second customer buys A7..A9.
  // Their own fixture merchant only has an abandoned checkout and no sales.
  buyer2 = await shop("Fixture Shop", "home", null);

  // Merchant A
  const a1 = withUser(A, await place(A, 1)); await pay(a1, NOW - 26 * HOUR);
  await deliverWithRiderOtp(sql, { orderId: a1.orderId, at: new Date(NOW - 26 * HOUR + 90 * MIN) });
  const a2 = withUser(A, await place(A, 2)); await pay(a2, NOW - 20 * HOUR);
  await deliverWithRiderOtp(sql, { orderId: a2.orderId, at: new Date(NOW - 20 * HOUR + 45 * MIN) });
  const a3 = withUser(A, await place(A, 1)); await pay(a3, NOW - 5 * HOUR); // open, past its 60-minute ETA
  const a4 = withUser(A, await place(A, 1)); const ref4 = await pay(a4, NOW - 4 * HOUR);
  await sql.query(`select prepare_provider_refund_for_payment($1,$2,'customer_order_cancellation')`, [a4.paymentId, A.user]);
  await refundEvent(a4, ref4, "refund.processed");
  const a5 = withUser(A, await place(A, 1)); // never paid: cancelled by the customer
  await sql.query(`with identity as (select set_config('app.user_id',$1,true)) select release_order_stock($2,$1) from identity`, [A.user, a5.orderId]);
  const a6 = withUser(A, await place(A, 1)); const ref6 = await pay(a6, NOW - 3 * HOUR);
  await sql.query(`select prepare_provider_refund_for_payment($1,$2,'customer_order_cancellation')`, [a6.paymentId, A.user]);
  await refundEvent(a6, ref6, "refund.failed");
  const a7 = withUser(buyer2, await place(A, 1, buyer2)); await pay(a7, NOW - 3 * HOUR);
  await sql.query(`select prepare_provider_refund_for_payment($1,$2,'customer_order_cancellation')`, [a7.paymentId, buyer2.user]);
  // A8: the checkout expired, then the provider confirmed a late payment. Not a sale.
  const a8 = withUser(buyer2, await place(A, 1, buyer2));
  const intent8 = await payments.createExternalPaymentIntent({ paymentId: a8.paymentId, userId: buyer2.user });
  await sql.query(`update orders set status='cancelled' where id=$1`, [a8.orderId]);
  provider.pay(intent8.providerReference);
  const raw8 = JSON.stringify({ event: "charge.success", data: { id: event++, reference: intent8.providerReference, amount: Math.round(Number(a8.grandTotal) * 100), currency: "GHS" } });
  await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw8, signature: provider.sign(raw8) });
  const [late8] = await sql.query(`select p.status, o.status as order_status from payments p join orders o on o.id=p.order_id where o.id=$1`, [a8.orderId]);
  assert.deepEqual(late8, { status: "completed", order_status: "cancelled" }, "late payment recorded on the cancelled checkout");
  const a9 = withUser(buyer2, await place(A, 1, buyer2)); await pay(a9, NOW - 10 * DAY); // paid before the range, still open

  // Merchant B
  const b1 = withUser(B, await place(B, 1)); await pay(b1, NOW - 10 * MIN); // open, within ETA
  const b2 = withUser(B, await place(B, 3)); await pay(b2, NOW - 30 * HOUR);
  await deliverWithRiderOtp(sql, { orderId: b2.orderId, at: new Date(NOW - 30 * HOUR + 200 * MIN) });
  await sql.query(
    `insert into risk_flags(id,subject_type,subject_id,flag_code,severity,status) values
       ('rf_rep_1','merchant',$1,'refund_spike','high','open'),
       ('rf_rep_2','merchant',$1,'chargeback','medium','open'),
       ('rf_rep_3','merchant',$1,'old_issue','low','resolved'),
       ('rf_rep_4','customer',$1,'not_a_merchant','low','open')`, [B.merchant]);

  // Returns: one requested, one approved.
  for (const [o, approve] of [[a1, false], [a2, true]]) {
    const [item] = await sql.query(`select id from order_items where order_id=$1`, [o.orderId]);
    const [{ r }] = await sql.query(`select request_order_return($1,$2,$3,'damaged','Customer explanation of the problem',1) as r`, [o.orderId, item.id, A.user]);
    if (approve) await sql.query(`update return_requests set status='approved' where id=$1`, [r.returnId]);
  }
});

after(async () => {
  if (!enabled) return;
  provider?.restore();
  await harness?.close();
  await db?.drop();
});

test("sales: only paid, non-cancelled orders in the range, with exact totals and daily series", { skip }, async () => {
  const report = await reports.loadAdminReport(sql, RANGE);
  const s = report.sales;
  // In range: A1 (100), A2 (200), A3, A4, A6, A7 (100 each), B1 (100), B2 (300).
  // Excluded: A5 (never paid), A8 (paid only after cancellation), A9 (paid before the range), fixture checkouts.
  assert.equal(s.orders, 8);
  assert.equal(s.gmv, "1100.00");
  assert.equal(s.deliveryFees, "120.00");
  assert.equal(s.commission, "90.00", "A: 10% of 700; B: 5% of 400");
  assert.equal(s.merchantEarnings, "1010.00");
  assert.equal(s.amountPaid, "1220.00");
  assert.equal(s.averageOrderValue, "152.50");
  assert.equal(report.timeZone, "Africa/Accra");
  assert.equal(s.daily.length, 4);
  assert.deepEqual(s.daily.map((d) => d.day), [0, 1, 2, 3].map((i) => day(NOW - (3 - i) * DAY)));
  // Expected per Accra (= UTC) day from the pinned payment times.
  const orders = [
    [NOW - 26 * HOUR, 100, 10], [NOW - 20 * HOUR, 200, 20], [NOW - 5 * HOUR, 100, 10], [NOW - 4 * HOUR, 100, 10],
    [NOW - 3 * HOUR, 100, 10], [NOW - 3 * HOUR, 100, 10], [NOW - 10 * MIN, 100, 5], [NOW - 30 * HOUR, 300, 15],
  ];
  for (const d of s.daily) {
    const mine = orders.filter(([t]) => day(t) === d.day);
    assert.equal(d.orders, mine.length, d.day);
    assert.equal(Number(d.gmv), mine.reduce((n, [, g]) => n + g, 0), d.day);
    assert.equal(Number(d.commission), mine.reduce((n, [, , c]) => n + c, 0), d.day);
    assert.equal(Number(d.deliveryFees), mine.length * 15, d.day);
  }
  assert.equal(s.daily.reduce((n, d) => n + d.orders, 0), 8);
});

test("refunds, cancellations and returns", { skip }, async () => {
  const r = (await reports.loadAdminReport(sql, RANGE)).refunds;
  assert.deepEqual(r.requested, {
    processedCount: 1, processedAmount: "115.00", pendingCount: 1, pendingAmount: "115.00", failedCount: 1, failedAmount: "115.00",
  });
  assert.equal(r.paidOrders, 8);
  assert.equal(r.paidValue, "1220.00");
  assert.equal(r.refundedOrders, 1);
  assert.equal(r.refundedValue, "115.00");
  assert.equal(r.refundRateByCount, "12.50");
  assert.equal(r.refundRateByValue, "9.43", "115 / 1220");
  assert.equal(r.cancelledAfterPayment, 3, "A4 refunded, A6 refund failed, A7 refund pending: none delivered");
  assert.equal(r.cancelledAfterPaymentRate, "37.50");
  // Placed now: 3 fixture checkouts + A1..A9 + B1, B2 = 14. Unpaid cancellations: 3 fixtures + A5 (A8 was paid late).
  assert.equal(r.ordersPlaced, 14);
  assert.equal(r.unpaidCancelled, 4);
  assert.equal(r.unpaidCancelledRate, "28.57");
  assert.deepEqual(r.returns, { opened: 2, approved: 1, refunded: 0 });
});

test("delivery: percentile_cont median and p90, ETA share, late orders, method split", { skip }, async () => {
  const d = (await reports.loadAdminReport(sql, RANGE)).delivery;
  // Timed deliveries: 45, 90 and 200 minutes.
  assert.equal(d.timedDeliveries, 3);
  assert.equal(d.medianMinutes, "90.0");
  assert.equal(d.p90Minutes, "178.0", "90 + 0.8 * (200 - 90)");
  assert.equal(d.withinEta, 1, "only the 45-minute delivery beat the 60-minute quote");
  assert.equal(d.withinEtaRate, "33.33");
  assert.equal(d.currentlyLate, 2, "A3 and A9 (paid before the range) are open past ETA; B1 is not yet due");
  assert.equal(d.doorOrders, 8);
  assert.equal(d.pickupOrders, 0);
});

test("merchant table: per-merchant numbers, GMV order, open merchant risk flags, escaped search", { skip }, async () => {
  const rows = (await reports.loadAdminReport(sql, RANGE)).merchants;
  assert.deepEqual(rows, [
    { merchantId: A.merchant, merchantName: "Ama Electronics", orders: 6, gmv: "700.00", refundRate: "16.67", cancellationRate: "50.00", medianDeliveryMinutes: "67.5", openRiskFlags: 0 },
    { merchantId: B.merchant, merchantName: "Kofi's 100% Fabrics", orders: 2, gmv: "400.00", refundRate: "0.00", cancellationRate: "0.00", medianDeliveryMinutes: "200.0", openRiskFlags: 2 },
  ]);
  const byName = await reports.loadMerchantReport(sql, { ...RANGE, days: 4 }, "100%");
  assert.deepEqual(byName.map((r) => r.merchantId), [B.merchant]);
  assert.deepEqual((await reports.loadMerchantReport(sql, { ...RANGE, days: 4 }, "%")).map((r) => r.merchantId), [B.merchant], "% is literal");
  assert.deepEqual((await reports.loadMerchantReport(sql, { ...RANGE, days: 4 }, "Ama_")).length, 0, "_ is literal (would match \"Ama \" as a wildcard)");
  assert.deepEqual((await reports.loadMerchantReport(sql, { ...RANGE, days: 4 }, A.merchant)).map((r) => r.merchantId), [A.merchant]);
});

test("category sales: GMV and units by product category", { skip }, async () => {
  const rows = (await reports.loadAdminReport(sql, RANGE)).categories;
  assert.deepEqual(rows, [
    { categoryKey: "electronics", categoryName: "Electronics", orders: 6, units: 7, gmv: "700.00" },
    { categoryKey: "fashion", categoryName: "Fashion", orders: 2, units: 4, gmv: "400.00" },
  ]);
});

test("a range outside the data is empty, not an error; invalid ranges are refused", { skip }, async () => {
  const empty = await reports.loadAdminReport(sql, { from: "2021-01-01", to: "2021-01-31" });
  assert.equal(empty.sales.orders, 0);
  assert.equal(empty.sales.gmv, "0");
  assert.equal(empty.sales.averageOrderValue, null);
  assert.equal(empty.sales.daily.length, 31);
  assert.equal(empty.refunds.refundRateByCount, null);
  assert.equal(empty.delivery.medianMinutes, null);
  assert.deepEqual(empty.merchants, []);
  await assert.rejects(reports.loadAdminReport(sql, { from: "2025-01-01", to: "2026-01-02" }), /at most 366 days/);
  await assert.rejects(reports.loadAdminReport(sql, { from: "2026-02-02", to: "2026-02-01" }), /on or before/);
  await assert.rejects(reports.loadAdminReport(sql, { from: "2026-02-30", to: "2026-03-01" }), /real calendar dates/);
  // The paid-before-range order (A9) shows up when its own day is selected.
  const a9Day = day(NOW - 10 * DAY);
  const earlier = await reports.loadAdminReport(sql, { from: a9Day, to: a9Day });
  assert.equal(earlier.sales.orders, 1);
  assert.equal(earlier.sales.gmv, "100.00");
});

test("CSV export: escaped, formula-guarded, and audited with range + section only", { skip }, async () => {
  const admin = "rep_admin_export";
  await sql.query(`insert into "user"(id,name,email,"emailVerified",role) values($1,$1,$2,true,'admin') on conflict do nothing`, [admin, `${admin}@example.test`]);
  const [{ name: original }] = await sql.query(`select name from merchants where id=$1`, [B.merchant]);
  await sql.query(`update merchants set name=$2 where id=$1`, [B.merchant, `=HYPERLINK("http://x.test"), Kofi`]);
  try {
    const out = await reports.buildReportExport(sql, { ...RANGE, section: "merchants", actorId: admin });
    assert.equal(out.filename, `elemarket-merchants-${RANGE.from}-to-${RANGE.to}.csv`);
    const lines = out.csv.trimEnd().split("\r\n");
    assert.equal(lines[0], "merchant_id,merchant_name,paid_orders,gmv_ghs,refund_rate_pct,cancellation_rate_pct,median_delivery_minutes,open_risk_flags");
    assert.equal(lines[1], `${A.merchant},Ama Electronics,6,700.00,16.67,50.00,67.5,0`);
    assert.equal(lines[2], `${B.merchant},"'=HYPERLINK(""http://x.test""), Kofi",2,400.00,0.00,0.00,200.0,2`);
  } finally {
    await sql.query(`update merchants set name=$2 where id=$1`, [B.merchant, original]);
  }
  const daily = await reports.buildReportExport(sql, { ...RANGE, section: "daily", actorId: admin });
  assert.equal(daily.csv.trimEnd().split("\r\n").length, 5, "header + 4 days");
  const categories = await reports.buildReportExport(sql, { ...RANGE, section: "categories", actorId: admin });
  assert.equal(categories.csv, "category_key,category_name,paid_orders,units,gmv_ghs\r\nelectronics,Electronics,6,7,700.00\r\nfashion,Fashion,2,4,400.00\r\n");
  const audits = await sql.query(
    `select event_type, resource_type, resource_id, actor_user_id, metadata from audit_events where actor_user_id=$1 order by id`, [admin]);
  assert.deepEqual(audits.map((a) => [a.event_type, a.resource_type, a.resource_id]), [
    ["admin.report.exported", "report", "merchants"], ["admin.report.exported", "report", "daily"], ["admin.report.exported", "report", "categories"],
  ]);
  assert.deepEqual(audits[0].metadata, { section: "merchants", from: RANGE.from, to: RANGE.to, days: 4, filtered: false, rowCount: 2 });
  assert.doesNotMatch(JSON.stringify(audits), /Ama Electronics|HYPERLINK|700\.00/, "no row data in the audit record");
  await assert.rejects(reports.buildReportExport(sql, { from: "2024-01-01", to: "2025-06-01", section: "daily", actorId: admin }), /366/);
});
