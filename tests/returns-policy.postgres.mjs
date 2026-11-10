// Return policy on REAL PostgreSQL (migration 0218): default window, faulty-item
// guarantee, both return entry points, and wallet release timing.
// Regression: listings had no window, so every return was refused while the
// wallet released earnings after 24 hours.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test npm run test:db:postgres
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { checkout, configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";
import { deliverWithRiderOtp } from "../scripts/helpers/delivery-fixture.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
const DAY = 86_400e3;
let db, harness, sql, payments, wallet, handlePaymentWebhook, provider, event = 90_000;

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url });
  provider = installPaymentProviderMock();
  harness = await startHarness();
  sql = harness.sql;
  payments = await harness.load("/src/modules/payments/public/payment.server.ts");
  wallet = await harness.load("/src/modules/wallet/public/wallet.server.ts");
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));
});
after(async () => {
  if (!enabled) return;
  provider?.restore();
  await harness?.close();
  await db?.drop();
});

/** A merchant whose one product has the given return settings (window NULL = legacy listing). */
async function shop({ returnable = true, window = null } = {}) {
  const seed = await seedOrder(sql);
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
  await sql.query(`update product_variants set stock=100 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=100, returnable=$2, return_window_days=$3 where id=$1`, [seed.product, returnable, window]);
  return seed;
}
/** Paid (simulated provider) and handed over by rider OTP `daysAgo` days ago. */
async function delivered(seed, daysAgo) {
  const order = await checkout(sql, seed);
  const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: seed.user });
  provider.pay(intent.providerReference);
  const raw = JSON.stringify({ event: "charge.success", data: { id: event++, reference: intent.providerReference, amount: Math.round(Number(order.grandTotal) * 100), currency: "GHS" } });
  await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
  await deliverWithRiderOtp(sql, { orderId: order.orderId, at: new Date(Date.now() - daysAgo * DAY) });
  const [item] = await sql.query(`select id from order_items where order_id=$1`, [order.orderId]);
  return { ...order, itemId: item.id };
}
const requestReturn = (seed, order, reason) => sql.query(
  `select request_order_return($1,$2,$3,$4,'Customer explanation of the problem',1) as r`,
  [order.orderId, order.itemId, seed.user, reason]).then(([row]) => row.r);

test("a listing created without a window gets the 7-day default", { skip }, async () => {
  const seed = await seedOrder(sql);
  const [p] = await sql.query(
    `insert into products(id,merchant_id,name,category,price,stock,status)
     select 'prod_ret_default', merchant_id, 'Default window product', category, price, 1, 'draft' from products where id=$1
     returning return_window_days`, [seed.product]);
  assert.equal(p.return_window_days, 7);
});

test("legacy listings with no window accept returns within 7 days, not after", { skip }, async () => {
  const seed = await shop({ window: null });
  const ok = await requestReturn(seed, await delivered(seed, 3), "changed_mind");
  assert.equal(ok.status, "requested");
  await assert.rejects(requestReturn(seed, await delivered(seed, 8), "changed_mind"), /return window has expired/);
});

test("non-returnable items can still be returned when faulty or wrong, within 7 days", { skip }, async () => {
  const seed = await shop({ returnable: false, window: 0 });
  await assert.rejects(requestReturn(seed, await delivered(seed, 1), "changed_mind"), /not returnable/);
  for (const reason of ["damaged", "wrong_item", "defective", "not_as_described", "missing_parts"]) {
    assert.equal((await requestReturn(seed, await delivered(seed, 6), reason)).status, "requested", reason);
  }
  await assert.rejects(requestReturn(seed, await delivered(seed, 8), "damaged"), /return window has expired/);
});

test("a seller's longer window is honoured for every reason", { skip }, async () => {
  const seed = await shop({ window: 30 });
  assert.equal((await requestReturn(seed, await delivered(seed, 20), "changed_mind")).status, "requested");
  assert.equal((await requestReturn(seed, await delivered(seed, 20), "damaged")).status, "requested");
});

test("shipment returns use the same rule as order returns", { skip }, async () => {
  const seed = await shop({ returnable: false, window: 0 });
  const order = await delivered(seed, 2);
  const query = (reason) => sql.query(
    `select 1 from order_items i join products p on p.id=i.product_id
      where i.id=$1 and now() <= elemarket_order_delivered_at(i.order_id) + make_interval(days=>elemarket_return_window_days(p.returnable,p.return_window_days,$2))`,
    [order.itemId, reason]);
  assert.equal((await query("changed_mind")).length, 0);
  assert.equal((await query("damaged")).length, 1);
});

test("merchant earnings stay withheld until the return window closes", { skip }, async () => {
  const seed = await shop({ window: null });
  await wallet.enableWalletForMerchant(seed.merchant, "admin_sim");
  const fresh = await delivered(seed, 2);
  const old = await delivered(seed, 8);
  await sql.query(`select release_matured_wallet_funds(1000)`);
  const released = async (o) => (await sql.query(`select 1 from wallet_ledger_entries where order_id=$1 and entry_type='release'`, [o.orderId])).length > 0;
  assert.equal(await released(fresh), false, "2 days after delivery: still inside the 7-day window");
  assert.equal(await released(old), true, "8 days after delivery: window closed");

  const long = await shop({ window: 30 });
  await wallet.enableWalletForMerchant(long.merchant, "admin_sim");
  const thirty = await delivered(long, 10);
  await sql.query(`select release_matured_wallet_funds(1000)`);
  assert.equal(await released(thirty), false, "a 30-day window holds earnings for 30 days");
});

test("staff can change the guarantee and it applies at once", { skip }, async () => {
  await sql.query(`update marketplace_return_policy set faulty_item_days=10, updated_by='admin_sim', updated_at=now()`);
  try {
    const seed = await shop({ returnable: false, window: 0 });
    assert.equal((await requestReturn(seed, await delivered(seed, 9), "damaged")).status, "requested");
  } finally {
    await sql.query(`update marketplace_return_policy set faulty_item_days=7`);
  }
});

test("orders delivered by rider handover (no shipment records) can be returned, but never more than bought", { skip }, async () => {
  const seed = await shop({ window: null });
  const order = await delivered(seed, 1);
  assert.equal((await sql.query(`select count(*)::int n from shipments where order_id=$1`, [order.orderId]))[0].n, 0);
  const first = await requestReturn(seed, order, "damaged");
  assert.equal(first.status, "requested");
  // The same item again returns the live request instead of a second one.
  assert.equal((await requestReturn(seed, order, "damaged")).returnId, first.returnId);
  // A direct insert beyond the purchased quantity is refused by the guard.
  await assert.rejects(sql.query(
    `insert into return_requests(id,order_id,order_item_id,customer_id,merchant_id,reason_code,reason,quantity)
     values('ret_overflow',$1,$2,$3,$4,'damaged','Second return attempt',1)`,
    [order.orderId, order.itemId, seed.user, seed.merchant]), /exceeds received shipment allocation/);
  // An undelivered order cannot be returned.
  const pending = await checkout(sql, seed);
  const [item] = await sql.query(`select id from order_items where order_id=$1`, [pending.orderId]);
  await assert.rejects(sql.query(
    `insert into return_requests(id,order_id,order_item_id,customer_id,merchant_id,reason_code,reason,quantity)
     values('ret_undelivered',$1,$2,$3,$4,'damaged','Not yet delivered',1)`,
    [pending.orderId, item.id, seed.user, seed.merchant]), /verified delivery handover/);
});
