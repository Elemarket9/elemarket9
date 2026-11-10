// Simulated order + mock Paystack payment through the real server code.
// Database: isolated in-memory PGlite with every migration applied.
// Network: Paystack API mocked in-process; no request leaves the machine.
// Run: npm run test:payment:simulation
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createPaymentFixture } from "../scripts/helpers/payment-fixture.mjs";
import { quoteCartCanonical } from "../src/lib/commerce-guards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = `sk_test_simulated_${"x".repeat(32)}`;
Object.assign(process.env, {
  ELEMARKET_ENV: "development",
  ELEMARKET_PAYMENT_ALLOWED_MODULES: "builtin:paystack",
  ELEMARKET_PAYMENT_DRIVER_PAYSTACK_MODULE: "builtin:paystack",
  ELEMARKET_PAYMENT_PAYSTACK_DRIVER: "paystack",
  ELEMARKET_PAYMENT_PAYSTACK_SECRET: SECRET,
  ELEMARKET_PAYMENT_PAYSTACK_CHECKOUT_HOSTS: "checkout.paystack.com",
  BETTER_AUTH_URL: "https://marketplace.example.com",
});
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

// ---------- Mock Paystack ----------
const ledger = new Map(); // reference -> { amount (pesewas), currency, status }
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname !== "api.paystack.co") return realFetch(url, init);
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (init.headers?.authorization !== `Bearer ${SECRET}`) return json(401, { status: false });
  if (u.pathname === "/transaction/initialize") {
    const b = JSON.parse(init.body);
    if (!ledger.has(b.reference))
      ledger.set(b.reference, { amount: Number(b.amount), currency: b.currency, status: "abandoned" });
    return json(200, {
      status: true,
      data: { reference: b.reference, authorization_url: `https://checkout.paystack.com/${b.reference.slice(0, 12)}`, access_code: "ac_sim" },
    });
  }
  const m = u.pathname.match(/^\/transaction\/verify\/(.+)$/);
  if (m) {
    const ref = decodeURIComponent(m[1]);
    const t = ledger.get(ref);
    if (!t) return json(404, { status: false });
    return json(200, { status: true, data: { status: t.status, reference: ref, amount: t.amount, currency: t.currency } });
  }
  return json(404, { status: false });
};
const sign = (raw) => createHmac("sha512", SECRET).update(raw).digest("hex");
const customerPays = (ref, ok = true) => {
  ledger.get(ref).status = ok ? "success" : "failed";
};

let vite, sql, createExternalPaymentIntent, handlePaymentWebhook;

before(async () => {
  vite = await createServer({
    root,
    configFile: false,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false },
    resolve: {
      alias: [
        { find: "@tanstack/react-start/server", replacement: path.join(root, "scripts/helpers/start-request-stub.mjs") },
        { find: "@", replacement: path.join(root, "src") },
      ],
    },
    ssr: { external: ["@electric-sql/pglite", "pg"] },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { getSql } = await vite.ssrLoadModule("/src/lib/db.ts");
  sql = await getSql(); // applies every migration to an isolated PGlite
  ({ createExternalPaymentIntent } = await vite.ssrLoadModule("/src/modules/payments/public/payment.server.ts"));
  ({ handlePaymentWebhook } = await vite.ssrLoadModule("/src/application/payment-webhook.server.ts"));
  await sql.query(
    `insert into payment_providers(id, provider_key, name, method, status, driver_key)
     values('pp_paystack','paystack','Paystack (simulated)','mobile_money','active','paystack')
     on conflict (provider_key) do update set status='active', driver_key='paystack'`,
  );
});

after(async () => {
  globalThis.fetch = realFetch;
  await vite?.close();
});

const merchantAccount = (merchantId) =>
  sql.query(
    `insert into merchant_payment_accounts(id, merchant_id, provider_key, provider_account_ref, status, verified_at)
     values($1, $2, 'paystack', $3, 'active', now()) on conflict do nothing`,
    [`mpa_${merchantId}`, merchantId, `ACCT_sim_${merchantId.slice(-8)}`],
  );

async function newOrder() {
  const ids = await createPaymentFixture((q, params) => sql.query(q, params));
  // Keep Paystack the only active provider so checkout selects it.
  await sql.query(`update payment_providers set status='inactive' where provider_key=$1`, [ids.provider]);
  await sql.query(`update payments set provider_key='paystack' where id=$1`, [ids.payment]);
  await merchantAccount(ids.merchant);
  return ids;
}

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
    return { ok: true, result: await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: signature ?? sign(raw) }) };
  } catch (error) {
    return { ok: false, status: error.status, message: error.message };
  }
}

test("paid order: checkout, retry, signed webhook, replay", async () => {
  const ids = await newOrder();
  const intent = await createExternalPaymentIntent({ paymentId: ids.payment, userId: ids.user });
  assert.equal(intent.status, "pending");
  assert.match(intent.checkoutUrl, /^https:\/\/checkout\.paystack\.com\//);
  assert.equal(ledger.get(intent.providerReference).amount, 11500, "GHS 100 + GHS 15 delivery");

  const retry = await createExternalPaymentIntent({ paymentId: ids.payment, userId: ids.user });
  assert.equal(retry.providerReference, intent.providerReference, "retry reuses the same charge");

  customerPays(intent.providerReference);
  const paid = await webhook("charge.success", { id: 9001, reference: intent.providerReference, amount: 11500, currency: "GHS" });
  assert.ok(paid.ok, paid.message);
  assert.deepEqual(await state(ids.order), { order: "paid", payment: "completed", amount: "115.00", reservation: "consumed" });

  const before = await state(ids.order);
  const replay = await webhook("charge.success", { id: 9001, reference: intent.providerReference, amount: 11500, currency: "GHS" });
  assert.ok(replay.ok && replay.result.duplicate === true);
  assert.deepEqual(await state(ids.order), before);
});

test("webhook attacks are rejected and leave the order unpaid", async () => {
  const ids = await newOrder();
  const intent = await createExternalPaymentIntent({ paymentId: ids.payment, userId: ids.user });
  const data = { id: 9002, reference: intent.providerReference, amount: 11500, currency: "GHS" };

  const forged = await webhook("charge.success", data, "a".repeat(128));
  assert.equal(forged.status, 401, "forged signature");

  const unpaid = await webhook("charge.success", data);
  assert.equal(unpaid.ok, false, "Paystack says not paid");

  customerPays(intent.providerReference);
  const tampered = await webhook("charge.success", { ...data, id: 9003, amount: 100 });
  assert.equal(tampered.ok, false, "amount differs from Paystack");

  assert.equal((await state(ids.order)).payment, "initiated");
});

test("declined payment cancels the order and releases stock", async () => {
  const ids = await newOrder();
  const intent = await createExternalPaymentIntent({ paymentId: ids.payment, userId: ids.user });
  customerPays(intent.providerReference, false);
  const failed = await webhook("charge.failed", { id: 9004, reference: intent.providerReference, amount: 11500, currency: "GHS" });
  assert.ok(failed.ok, failed.message);
  assert.deepEqual(await state(ids.order), { order: "cancelled", payment: "failed", amount: "115.00", reservation: "released" });
  const [{ stock }] = await sql.query(`select stock from product_variants where id=$1`, [ids.variant]);
  assert.equal(Number(stock), 1, "reserved unit returned to stock");
});

test("a customer cannot start another customer's payment", async () => {
  const owner = await newOrder();
  const other = await newOrder();
  await assert.rejects(createExternalPaymentIntent({ paymentId: owner.payment, userId: other.user }));
});

test("100%-discounted product: real checkout charges delivery only, then pays", async () => {
  const seed = await newOrder(); // verified customer, active merchant, product and variant
  const address = "1 Test Street";
  await sql.query(`update product_variants set stock=5 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=5 where id=$1`, [seed.product]);
  const items = [{ productId: seed.product, variantId: seed.variant, quantity: 1 }];
  const fingerprint = createHash("sha256")
    .update(quoteCartCanonical({ merchantId: seed.merchant, address, tier: "same_day", items }))
    .digest("hex");
  const quoteId = `${seed.quote}_free`;
  await sql.query(
    `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,expires_at)
     values($1,$2,$3,$4,'same_day',15,60,1,$5,now()+interval '1 hour')`,
    [quoteId, seed.user, seed.merchant, fingerprint, address],
  );
  const code = `FREE${seed.user.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
  await sql.query(
    `insert into promotions(id,code,name,discount_type,discount_value,starts_at,ends_at,status,created_by)
     values($1,$2,'Everything free','percentage',100,now()-interval '1 hour',now()+interval '1 day','active','simulation')`,
    [`promo_${seed.user}`, code],
  );
  // Cancel the seed order so it does not count toward the unpaid-order quota.
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);

  const [{ result }] = await sql.query(
    `with identity as (select set_config('app.user_id',$1,true) u)
     select create_pending_order($1,$2,$3,$4::jsonb,$5::jsonb,$6,'mobile_money',$7) as result from identity`,
    [seed.user, `${seed.idem}_free_0123`, "b".repeat(64), JSON.stringify(items),
      JSON.stringify([{ merchantId: seed.merchant, quoteId }]), address, code],
  );
  const order = result.orders[0];
  assert.equal(Number(order.productTotal), 0, "product fully discounted");
  assert.equal(Number(order.promoDiscount), 100);
  assert.equal(Number(order.grandTotal), 15, "customer pays delivery only");

  const intent = await createExternalPaymentIntent({ paymentId: order.paymentId, userId: seed.user });
  assert.equal(ledger.get(intent.providerReference).amount, 1500, "Paystack charge is GHS 15");
  customerPays(intent.providerReference);
  const paid = await webhook("charge.success", { id: 9010, reference: intent.providerReference, amount: 1500, currency: "GHS" });
  assert.ok(paid.ok, paid.message);
  const final = await state(order.orderId);
  assert.equal(final.order, "paid");
  assert.equal(final.payment, "completed");
});

test("free delivery stays blocked: the delivery fee pays the rider", async () => {
  const seed = await newOrder();
  await assert.rejects(
    sql.query(
      `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,expires_at)
       values($1,$2,$3,$4,'same_day',0,60,1,'1 Test Street',now()+interval '1 hour')`,
      [`${seed.quote}_zero`, seed.user, seed.merchant, seed.quoteFingerprint],
    ),
    /invalid delivery quote price/,
  );
});
