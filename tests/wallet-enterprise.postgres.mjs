// Wallet is the default; enterprise merchants are paid instantly (migration 0240).
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test npm run test:db:postgres
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { checkout, configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
let db, harness, sql, payments, wallet, handlePaymentWebhook, provider, event = 240_000;
const admin = `wal_admin_${randomBytes(4).toString("hex")}`;

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
  await sql.query(`insert into "user"(id,name,email,"emailVerified",role) values($1,'Admin',$2,true,'admin')`, [admin, `${admin}@example.test`]);
});
after(async () => {
  if (!enabled) return;
  provider?.restore();
  await harness?.close();
  await db?.drop();
});

/** A merchant on the wallet, optionally enterprise, with one paid order. */
async function shop({ tier = "merchant" } = {}) {
  const s = await seedOrder(sql);
  await sql.query(`update orders set status='cancelled' where id=$1`, [s.order]);
  await sql.query(`update product_variants set stock=50 where id=$1`, [s.variant]);
  await sql.query(`update products set stock=50 where id=$1`, [s.product]);
  await wallet.enableWalletForMerchant(s.merchant, admin);
  if (tier === "enterprise") await sql.query(`update merchants set tier='enterprise' where id=$1`, [s.merchant]);
  return s;
}
async function paidOrder(s) {
  const order = await checkout(sql, s);
  const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: s.user });
  provider.pay(intent.providerReference);
  const raw = JSON.stringify({ event: "charge.success", data: { id: event++, reference: intent.providerReference, amount: Math.round(Number(order.grandTotal) * 100), currency: "GHS" } });
  await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
  const [o] = await sql.query(`select status, merchant_net::text from orders where id=$1`, [order.orderId]);
  assert.equal(o.status, "paid");
  return { ...order, merchantNet: o.merchant_net };
}
const balances = async (merchant) => Object.fromEntries((await sql.query(
  `select bucket, sum(amount)::numeric(12,2)::text as total from wallet_ledger_entries where merchant_id=$1 group by bucket`, [merchant])).map((r) => [r.bucket, r.total]));

test("new merchants start on the ELEMARKET wallet", { skip }, async () => {
  const id = `m_new_${randomBytes(4).toString("hex")}`;
  await sql.query(`insert into merchants(id,name,category,status,verified,address,city,neighborhood,lat,lon,catalog_categories) values($1,'New Shop','electronics','active',true,'1 Road','Accra','Osu',5.6,-0.18,ARRAY['electronics'])`, [id]);
  const [m] = await sql.query(`select settlement_model from merchants where id=$1`, [id]);
  assert.equal(m.settlement_model, "platform_wallet");
});

test("ordinary merchant: the sale is held after payment, not withdrawable", { skip }, async () => {
  const s = await shop();
  const order = await paidOrder(s);
  const b = await balances(s.merchant);
  assert.equal(b.withheld, order.merchantNet);
  assert.equal(b.available ?? "0.00", "0.00");
  assert.equal(await sql.query(`select release_matured_wallet_funds(100) as n`).then((r) => r[0].n), 0, "not delivered yet");
});

test("enterprise merchant: the sale is available the moment payment is confirmed", { skip }, async () => {
  const s = await shop({ tier: "enterprise" });
  const order = await paidOrder(s);
  const b = await balances(s.merchant);
  assert.equal(b.withheld, "0.00");
  assert.equal(b.available, order.merchantNet, "no delivery wait, no 24-hour hold");
  // Withdrawable straight away (once a payout account exists).
  const [entries] = await sql.query(`select count(*)::int as n from wallet_ledger_entries where order_id=$1 and entry_type='release' and bucket='available'`, [order.orderId]);
  assert.equal(entries.n, 1, "released once");
  assert.equal(await sql.query(`select wallet_release_order($1) as ok`, [order.orderId]).then((r) => r[0].ok), false, "idempotent");
});

test("enterprise refund after instant release comes out of the available balance", { skip }, async () => {
  const s = await shop({ tier: "enterprise" });
  const a = await paidOrder(s);
  const b = await paidOrder(s);
  assert.equal((await balances(s.merchant)).available, (Number(a.merchantNet) + Number(b.merchantNet)).toFixed(2));
  await sql.query(`select wallet_apply_refund($1,$2,$3)`, [a.orderId, a.merchantNet, `refund:test:${a.orderId}`]);
  const after = await balances(s.merchant);
  assert.equal(after.available, b.merchantNet, "refund debited from released money");
  assert.equal(after.recovery ?? "0.00", "0.00");
  // A refund larger than the balance becomes "owed" and is repaid from the next sale
  // (existing wallet_apply_refund behaviour, covered by test:wallet:postgres).
});

test("enterprise on a Paystack subaccount (enterprise_direct) is unchanged: never credited to the wallet", { skip }, async () => {
  const s = await seedOrder(sql);
  await sql.query(`update merchants set tier='enterprise', settlement_model='enterprise_direct' where id=$1`, [s.merchant]);
  const rows = await sql.query(`select 1 from wallet_ledger_entries where merchant_id=$1`, [s.merchant]);
  assert.equal(rows.length, 0);
  // Staff can move it to the wallet.
  await sql.query(`update orders set status='cancelled' where id=$1`, [s.order]);
  const moved = await wallet.enableWalletForMerchant(s.merchant, admin);
  assert.equal(moved.settlementModel, "platform_wallet");
});

test("the enterprise order integration follows the tier, not the payment route (and now actually enqueues)", { skip }, async () => {
  const s = await shop({ tier: "enterprise" });
  const order = await paidOrder(s);
  // Switch to the API catalogue after the sale (new API orders need a live catalogue connection).
  await sql.query(`update merchants set catalog_source='enterprise_api' where id=$1`, [s.merchant]);
  const [r] = await sql.query(`select enterprise_enqueue_order_event($1,'order.created','{}'::jsonb) as id`, [order.orderId]);
  assert.match(r.id ?? "", /^eoo_/, "a wallet-paid enterprise order is sent to the merchant's system");
  const [again] = await sql.query(`select enterprise_enqueue_order_event($1,'order.created','{}'::jsonb) as id`, [order.orderId]);
  const rows = await sql.query(`select idempotency_key from enterprise_order_outbox where order_id=$1`, [order.orderId]);
  assert.equal(rows.length, 1, "duplicate events are absorbed by the idempotency key");
  assert.ok(again);
  const plain = await shop();
  const other = await paidOrder(plain);
  const [none] = await sql.query(`select enterprise_enqueue_order_event($1,'order.created','{}'::jsonb) as id`, [other.orderId]);
  assert.equal(none.id, null, "non-enterprise orders are never sent");
});
