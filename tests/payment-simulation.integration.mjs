// Simulated order + mock payment provider through the real server code.
// Run: npm run test:payment:simulation
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  checkout,
  configureSimulationEnv,
  installPaymentProviderMock,
  seedOrder,
  startHarness,
} from "../scripts/helpers/server-harness.mjs";

configureSimulationEnv();
const provider = installPaymentProviderMock();
let harness, sql, createExternalPaymentIntent, handlePaymentWebhook;

before(async () => {
  harness = await startHarness();
  sql = harness.sql;
  ({ createExternalPaymentIntent } = await harness.load("/src/modules/payments/public/payment.server.ts"));
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));
});
after(async () => {
  provider.restore();
  await harness?.close();
});

async function state(orderId) {
  const [row] = await sql.query(
    `select o.status as "order", p.status as payment, p.amount::text as amount,
            (select string_agg(status, ',') from order_stock_reservations where order_id=o.id) as reservation
       from orders o join payments p on p.order_id=o.id where o.id=$1`,
    [orderId],
  );
  return row;
}

async function webhook(event, data, signature) {
  const raw = JSON.stringify({ event, data });
  try {
    return { ok: true, result: await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: signature ?? provider.sign(raw) }) };
  } catch (error) {
    return { ok: false, status: error.status, message: error.message };
  }
}

test("paid order: checkout, retry, signed webhook, replay", async () => {
  const ids = await seedOrder(sql);
  const intent = await createExternalPaymentIntent({ paymentId: ids.payment, userId: ids.user });
  assert.equal(intent.status, "pending");
  assert.match(intent.checkoutUrl, /^https:\/\/checkout\.paystack\.com\//);
  assert.equal(provider.ledger.get(intent.providerReference).amount, 11500, "GHS 100 + GHS 15 delivery");

  const retry = await createExternalPaymentIntent({ paymentId: ids.payment, userId: ids.user });
  assert.equal(retry.providerReference, intent.providerReference, "retry reuses the same charge");

  provider.pay(intent.providerReference);
  const paid = await webhook("charge.success", { id: 9001, reference: intent.providerReference, amount: 11500, currency: "GHS" });
  assert.ok(paid.ok, paid.message);
  assert.deepEqual(await state(ids.order), { order: "paid", payment: "completed", amount: "115.00", reservation: "consumed" });

  const before = await state(ids.order);
  const replay = await webhook("charge.success", { id: 9001, reference: intent.providerReference, amount: 11500, currency: "GHS" });
  assert.ok(replay.ok && replay.result.duplicate === true);
  assert.deepEqual(await state(ids.order), before);
});

test("webhook attacks are rejected and leave the order unpaid", async () => {
  const ids = await seedOrder(sql);
  const intent = await createExternalPaymentIntent({ paymentId: ids.payment, userId: ids.user });
  const data = { id: 9002, reference: intent.providerReference, amount: 11500, currency: "GHS" };

  const forged = await webhook("charge.success", data, "a".repeat(128));
  assert.equal(forged.status, 401, "forged signature");

  const unpaid = await webhook("charge.success", data);
  assert.equal(unpaid.ok, false, "provider says not paid");

  provider.pay(intent.providerReference);
  const tampered = await webhook("charge.success", { ...data, id: 9003, amount: 100 });
  assert.equal(tampered.ok, false, "amount differs from provider");

  assert.equal((await state(ids.order)).payment, "initiated");
});

test("declined payment cancels the order and releases stock", async () => {
  const ids = await seedOrder(sql);
  const intent = await createExternalPaymentIntent({ paymentId: ids.payment, userId: ids.user });
  provider.pay(intent.providerReference, false);
  const failed = await webhook("charge.failed", { id: 9004, reference: intent.providerReference, amount: 11500, currency: "GHS" });
  assert.ok(failed.ok, failed.message);
  assert.deepEqual(await state(ids.order), { order: "cancelled", payment: "failed", amount: "115.00", reservation: "released" });
  const [{ stock }] = await sql.query(`select stock from product_variants where id=$1`, [ids.variant]);
  assert.equal(Number(stock), 1, "reserved unit returned to stock");
});

test("a customer cannot start another customer's payment", async () => {
  const owner = await seedOrder(sql);
  const other = await seedOrder(sql);
  await assert.rejects(createExternalPaymentIntent({ paymentId: owner.payment, userId: other.user }));
});

test("100%-discounted product: real checkout charges delivery only, then pays", async () => {
  const seed = await seedOrder(sql);
  await sql.query(`update product_variants set stock=5 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=5 where id=$1`, [seed.product]);
  const code = `FREE${seed.user.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
  await sql.query(
    `insert into promotions(id,code,name,discount_type,discount_value,starts_at,ends_at,status,created_by)
     values($1,$2,'Everything free','percentage',100,now()-interval '1 hour',now()+interval '1 day','active','simulation')`,
    [`promo_${seed.user}`, code],
  );
  // Cancel the seed order so it does not count toward the unpaid-order quota.
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);

  const order = await checkout(sql, seed, { promoCode: code });
  assert.equal(Number(order.productTotal), 0, "product fully discounted");
  assert.equal(Number(order.promoDiscount), 100);
  assert.equal(Number(order.grandTotal), 15, "customer pays delivery only");

  const intent = await createExternalPaymentIntent({ paymentId: order.paymentId, userId: seed.user });
  assert.equal(provider.ledger.get(intent.providerReference).amount, 1500, "provider charge is GHS 15");
  provider.pay(intent.providerReference);
  const paid = await webhook("charge.success", { id: 9010, reference: intent.providerReference, amount: 1500, currency: "GHS" });
  assert.ok(paid.ok, paid.message);
  const final = await state(order.orderId);
  assert.equal(final.order, "paid");
  assert.equal(final.payment, "completed");
});

test("free delivery stays blocked: the delivery fee pays the rider", async () => {
  const seed = await seedOrder(sql);
  await assert.rejects(
    sql.query(
      `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,expires_at)
       values($1,$2,$3,$4,'same_day',0,60,1,'1 Test Street',now()+interval '1 hour')`,
      [`${seed.quote}_zero`, seed.user, seed.merchant, seed.quoteFingerprint],
    ),
    /invalid delivery quote price/,
  );
});
