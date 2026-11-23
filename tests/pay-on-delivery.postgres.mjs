// Pay on delivery (mobile money at the door) on REAL PostgreSQL, migration 0220.
// The payment provider is SIMULATED; prompts, webhooks and verification go
// through the real Paystack driver code against the in-process mock.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test npm run test:db:postgres
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { checkout, configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";
import { deliverWithRiderOtp } from "../scripts/helpers/delivery-fixture.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
let db, harness, sql, pod, wallet, handlePaymentWebhook, provider, event = 97_000;
const id = (p) => `${p}_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url });
  provider = installPaymentProviderMock();
  harness = await startHarness();
  sql = harness.sql;
  pod = await harness.load("/src/modules/payments/internal/pay-on-delivery.server.ts");
  wallet = await harness.load("/src/modules/wallet/public/wallet.server.ts");
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));
  await sql.query(`update pay_on_delivery_policy set enabled=true, max_order_amount=500, max_open_orders=2, max_refused_deliveries=2`);
});
after(async () => {
  if (!enabled) return;
  provider?.restore();
  await harness?.close();
  await db?.drop();
});

/** A customer with an OTP-verified phone on the given network prefix (24 = MTN, 20 = Telecel). */
async function customer(prefix = "24") {
  const user = id("cust"), phone = `+233${prefix}${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, challenge = id("otp");
  await sql.query(`insert into "user"(id,name,email,"emailVerified") values($1,'Door Customer',$2,true)`, [user, `${user}@sim.test`]);
  await sql.query(`insert into profiles(user_id,name,phone) values($1,'Door Customer',$2)`, [user, phone]);
  await sql.query(`insert into otp_challenges(id,user_id,destination,purpose,provider,status,expires_at,cooldown_until,verified_at)
                   values($1,$2,$3,'phone_verification','sim-sms','verified',now()+interval '5 minutes',now(),now())`, [challenge, user, phone]);
  await sql.query(`select confirm_phone_verification($1,$2)`, [user, challenge]);
  return { user, phone };
}
let shopSeed;
async function shop() {
  if (shopSeed) return shopSeed;
  const seed = await seedOrder(sql);
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
  await sql.query(`update product_variants set stock=100 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=100 where id=$1`, [seed.product]);
  await wallet.enableWalletForMerchant(seed.merchant, "admin_sim");
  shopSeed = seed;
  return seed;
}
/** Checkout, then choose pay on delivery at the review step. */
async function podOrder(c) {
  const seed = await shop();
  const order = await checkout(sql, { ...seed, user: c.user });
  const [{ r }] = await sql.query(`select choose_pay_on_delivery($1,(select group_id from orders where id=$2)) as r`, [c.user, order.orderId]);
  assert.equal(r.paymentTiming, "on_delivery");
  return order;
}
/** Merchant packs and the rider sets off: order shipped, job in transit. */
async function onTheWay(order) {
  for (const s of ["fulfilling", "shipped"]) await sql.query(`update orders set status=$2 where id=$1`, [order.orderId, s]);
}
const state = (orderId) => sql.query(
  `select o.status, o.payment_timing, p.status as payment_status,
          (select count(*)::int from order_stock_reservations r where r.order_id=o.id and r.status='reserved') as reserved
     from orders o join payments p on p.order_id=o.id where o.id=$1`, [orderId]).then((r) => r[0]);
async function webhook(reference, ok) {
  const [{ amount }] = await sql.query(`select p.amount from payments p join payment_attempts a on a.payment_id=p.id where a.provider_reference=$1`, [reference]);
  const raw = JSON.stringify({ event: ok ? "charge.success" : "charge.failed", data: { id: event++, reference, amount: Math.round(Number(amount) * 100), currency: "GHS" } });
  return handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
}
const lastCharge = () => provider.chargeBodies.at(-1);

test("customers cannot choose it while switched off, over the limit, or with too many open", { skip }, async () => {
  await sql.query(`update pay_on_delivery_policy set enabled=false`);
  const c = await customer();
  const seed = await shop();
  const order = await checkout(sql, { ...seed, user: c.user });
  const group = `(select group_id from orders where id='${order.orderId}')`;
  await assert.rejects(sql.query(`select choose_pay_on_delivery($1,${group})`, [c.user]), /not available yet/);
  await sql.query(`update pay_on_delivery_policy set enabled=true, max_order_amount=10`);
  await assert.rejects(sql.query(`select choose_pay_on_delivery($1,${group})`, [c.user]), /limited to GHS 10.00/);
  await sql.query(`update pay_on_delivery_policy set max_order_amount=500`);
  await podOrder(c); await podOrder(c);
  await assert.rejects(podOrder(c), /unpaid pay-on-delivery orders on the way/);
});

test("a pay-on-delivery order is confirmed and dispatched unpaid, stock held, not expired", { skip }, async () => {
  const c = await customer();
  const order = await podOrder(c);
  assert.deepEqual(await state(order.orderId), { status: "confirmed", payment_timing: "on_delivery", payment_status: "initiated", reserved: 1 });
  assert.equal((await sql.query(`select count(*)::int n from delivery_dispatch_outbox where order_id=$1`, [order.orderId]))[0].n, 1, "queued for dispatch");
  await sql.query(`update orders set created_at=now()-interval '2 days' where id=$1`, [order.orderId]).catch(() => undefined);
  await sql.query(`select expire_payment_pending_orders(100)`);
  assert.equal((await state(order.orderId)).status, "confirmed", "the unpaid-order expiry job leaves it alone");
});

test("no handover before payment: not the code, not the handover, not delivered", { skip }, async () => {
  const c = await customer();
  const order = await podOrder(c);
  await onTheWay(order);
  await assert.rejects(deliverWithRiderOtp(sql, { orderId: order.orderId }), /collect the mobile money payment before handover/);
  // Two independent guards refuse this; either message proves the parcel stays undelivered.
  await assert.rejects(sql.query(`update orders set status='delivered' where id=$1`, [order.orderId]), /cannot be delivered|receipt required/);
});

test("at the door: one prompt to the verified phone, decline and retry, approve, then hand over", { skip }, async () => {
  const c = await customer("24");
  const order = await podOrder(c);
  await onTheWay(order);
  const before = provider.chargeBodies.length;

  const first = await pod.requestPayOnDeliveryPrompt(order.orderId);
  assert.equal(first.state, "prompt_sent");
  assert.deepEqual(lastCharge().mobile_money, { phone: `0${c.phone.slice(4)}`, provider: "mtn" });
  assert.equal(Number(lastCharge().amount), Math.round(Number(order.grandTotal) * 100));

  // Asking again while the prompt is live sends nothing new.
  assert.equal((await pod.requestPayOnDeliveryPrompt(order.orderId)).state, "awaiting_customer");
  assert.equal(provider.chargeBodies.length, before + 1, "no second prompt while the first can be approved");

  // The customer declines: only that attempt fails; the order stays out for delivery.
  await webhook(lastCharge().reference, false);
  assert.deepEqual(await state(order.orderId), { status: "shipped", payment_timing: "on_delivery", payment_status: "initiated", reserved: 1 });

  // Retry, approve.
  assert.equal((await pod.requestPayOnDeliveryPrompt(order.orderId)).state, "prompt_sent");
  const approved = lastCharge().reference;
  assert.notEqual(approved, provider.chargeBodies[before].reference, "a new reference per attempt");
  provider.pay(approved);
  await webhook(approved, true);
  assert.deepEqual(await state(order.orderId), { status: "shipped", payment_timing: "on_delivery", payment_status: "completed", reserved: 0 },
    "paid, stock consumed, and the order keeps its delivery status");
  assert.equal((await pod.requestPayOnDeliveryPrompt(order.orderId)).state, "paid");

  // The merchant's earning is withheld in the wallet; the handover now succeeds.
  const [credit] = await sql.query(`select sum(amount)::numeric n from wallet_ledger_entries where order_id=$1 and bucket='withheld'`, [order.orderId]);
  assert.ok(Number(credit.n) > 0, "merchant earning credited as withheld");
  await deliverWithRiderOtp(sql, { orderId: order.orderId });
  assert.equal((await state(order.orderId)).status, "delivered");
});

test("a stale prompt is checked with the provider before a new one; an approved one is never re-sent", { skip }, async () => {
  const c = await customer();
  const order = await podOrder(c);
  await onTheWay(order);
  await pod.requestPayOnDeliveryPrompt(order.orderId);
  const ref = lastCharge().reference;
  const age = () => sql.query(`update payment_attempts set created_at=now()-interval '4 minutes' where provider_reference=$1`, [ref]);

  // Approved at the provider but the webhook has not arrived: wait, do not re-prompt.
  await age();
  provider.ledger.get(ref).status = "success";
  const count = provider.chargeBodies.length;
  assert.equal((await pod.requestPayOnDeliveryPrompt(order.orderId)).state, "confirming");
  assert.equal(provider.chargeBodies.length, count);

  // Abandoned at the provider: closed, and a fresh prompt goes out.
  provider.ledger.get(ref).status = "abandoned";
  assert.equal((await pod.requestPayOnDeliveryPrompt(order.orderId)).state, "prompt_sent");
  assert.equal(provider.chargeBodies.length, count + 1);
  assert.equal((await sql.query(`select status from payment_attempts where provider_reference=$1`, [ref]))[0].status, "failed");
});

test("Telecel numbers need the customer's voucher code", { skip }, async () => {
  const c = await customer("20");
  const order = await podOrder(c);
  await onTheWay(order);
  const sent = await pod.requestPayOnDeliveryPrompt(order.orderId);
  assert.equal(lastCharge().mobile_money.provider, "vod");
  assert.equal(sent.needsCustomerCode, true);
  await pod.submitPayOnDeliveryCode(order.orderId, "123456");
  assert.deepEqual(lastCharge().submitOtp, { otp: "123456", reference: provider.chargeBodies.at(-2).reference });
});

test("a refused parcel returned to the merchant cancels the order, restocks, and counts against the customer", { skip }, async () => {
  const c = await customer();
  const seed = await shop();
  const [{ stock: before }] = await sql.query(`select stock from product_variants where id=$1`, [seed.variant]);
  for (let refusal = 1; refusal <= 2; refusal++) {
    const order = await podOrder(c);
    await onTheWay(order);
    const [{ provider_id }] = await sql.query(`select q.provider_id from orders o join delivery_quotes q on q.id=o.delivery_quote_id where o.id=$1`, [order.orderId]);
    const job = id("dj");
    const providerId = provider_id ?? (await sql.query(`insert into delivery_providers(id,provider_key,name,status) values($1,$1,'Sim','active') returning id`, [id("dprov")]))[0].id;
    await sql.query(`insert into delivery_jobs(id,order_id,provider_id,status,handover_kind) values($1,$2,$3,'assigned','delivery')`, [job, order.orderId, providerId]);
    for (const s of ["accepted", "picked_up", "in_transit"]) await sql.query(`update delivery_jobs set status=$2 where id=$1`, [job, s]);
    await sql.query(`update delivery_jobs set status='failed', failure_reason='Customer refused to pay at the door' where id=$1`, [job]);
    for (const s of ["return_requested", "returned"]) await sql.query(`update delivery_jobs set status=$2 where id=$1`, [job, s]);
    const s = await state(order.orderId);
    assert.equal(s.status, "cancelled");
    assert.equal(s.reserved, 0);
  }
  const [{ stock: after }] = await sql.query(`select stock from product_variants where id=$1`, [seed.variant]);
  assert.equal(after, before, "refused stock is back on sale");
  const [{ e }] = await sql.query(`select elemarket_pay_on_delivery_eligibility($1) as e`, [c.user]);
  assert.equal(e.eligible, false);
  assert.match(e.reason, /refused deliveries/);
});
