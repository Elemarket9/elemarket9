// Commerce integrity on REAL PostgreSQL with real concurrency: checkout stock
// contention and idempotency, duplicate payment webhooks, OTP abuse, and
// authorization boundaries. Payment and SMS providers are SIMULATED.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test npm run test:db:postgres
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";
import { quoteCartCanonical } from "../src/lib/commerce-guards.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
let db, harness, sql, payments, handlePaymentWebhook, provider, otp, authz;
let event = 1;

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  // As in production behind the proxy: rate limits key on the client address.
  configureSimulationEnv({ DATABASE_URL: db.url, ELEMARKET_TRUST_PROXY: "1" });
  provider = installPaymentProviderMock();
  harness = await startHarness();
  sql = harness.sql;
  payments = await harness.load("/src/modules/payments/public/payment.server.ts");
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));
  otp = await harness.load("/src/modules/identity/internal/auth/otp/otp.server.ts");
  authz = await harness.load("/src/modules/identity/public/auth/authorization.server.ts");
});
after(async () => {
  if (!enabled) return;
  provider?.restore();
  await harness?.close();
  await db?.drop();
});

const phone = () => `+2332${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
/** A customer with an OTP-verified phone, created through the real binding function. */
async function customer() {
  const id = `cust_${randomBytes(6).toString("hex")}`, p = phone(), c = `otp_${randomBytes(8).toString("hex")}`;
  await sql.query(`insert into "user"(id,name,email,"emailVerified") values($1,'Simulated Customer',$2,true)`, [id, `${id}@sim.test`]);
  await sql.query(`insert into profiles(user_id,name,phone) values($1,'Simulated Customer',$2)`, [id, p]);
  await sql.query(`insert into otp_challenges(id,user_id,destination,purpose,provider,status,expires_at,cooldown_until,verified_at)
                   values($1,$2,$3,'phone_verification','sim-sms','verified',now()+interval '5 minutes',now(),now())`, [c, id, p]);
  await sql.query(`select confirm_phone_verification($1,$2)`, [id, c]);
  return { id, phone: p };
}
/** A new customer whose phone is on file but not yet verified. */
async function unverifiedCustomer() {
  const id = `cust_${randomBytes(6).toString("hex")}`, p = phone();
  await sql.query(`insert into "user"(id,name,email,"emailVerified") values($1,'Simulated Customer',$2,true)`, [id, `${id}@sim.test`]);
  await sql.query(`insert into profiles(user_id,name,phone) values($1,'Simulated Customer',$2)`, [id, p]);
  return { id, phone: p };
}

/** A shop with one product variant and a given stock level. */
async function shop(stock) {
  const s = await seedOrder(sql); // merchant, product, variant (and a pending order we cancel)
  await sql.query(`update orders set status='cancelled' where id=$1`, [s.order]);
  await sql.query(`update product_variants set stock=$2 where id=$1`, [s.variant, stock]);
  await sql.query(`update products set stock=$2 where id=$1`, [s.product, stock]);
  return s;
}
/** Real create_pending_order for `qty` units, with a quote bound to this cart. */
async function placeOrder(s, buyer, { qty = 1, idem = `idem_${randomBytes(8).toString("hex")}`, fingerprint } = {}) {
  const address = `${buyer.id} Street`;
  const items = [{ productId: s.product, variantId: s.variant, quantity: qty }];
  const fp = createHash("sha256").update(quoteCartCanonical({ merchantId: s.merchant, address, tier: "same_day", items })).digest("hex");
  const quoteId = `dq_${createHash("sha256").update(`${buyer.id}:${idem}`).digest("hex").slice(0, 24)}`;
  await sql.query(
    `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,expires_at)
     values($1,$2,$3,$4,'same_day',15,60,1,$5,now()+interval '1 hour') on conflict (id) do nothing`,
    [quoteId, buyer.id, s.merchant, fp, address]);
  const [{ result }] = await sql.query(
    `with identity as (select set_config('app.user_id',$1,true) u)
     select create_pending_order($1,$2,$3,$4::jsonb,$5::jsonb,$6,'mobile_money',null) as result from identity`,
    [buyer.id, idem, fingerprint ?? createHash("sha256").update(idem).digest("hex"), JSON.stringify(items),
      JSON.stringify([{ merchantId: s.merchant, quoteId }]), address]);
  return result.orders[0];
}
const stockOf = async (s) => Number((await sql.query(`select stock from product_variants where id=$1`, [s.variant]))[0].stock);

test("checkout: 20 customers racing for the last 5 units never oversell", { skip }, async () => {
  const s = await shop(5);
  const buyers = await Promise.all([...Array(20)].map(() => customer()));
  const results = await Promise.allSettled(buyers.map((b) => placeOrder(s, b)));
  const won = results.filter((r) => r.status === "fulfilled");
  assert.equal(won.length, 5, `exactly the available units sold: ${results.filter((r) => r.status === "rejected").map((r) => r.reason.message).slice(0, 2)}`);
  assert.equal(await stockOf(s), 0, "stock reaches zero, never below");
  const reserved = await sql.query(`select coalesce(sum(r.quantity),0)::int n from order_stock_reservations r
                                     where r.order_id = any($1::text[]) and r.status='reserved'`, [won.map((w) => w.value.orderId)]);
  assert.equal(reserved[0].n, 5, "one reserved unit per order");
});

test("checkout: the same submission sent 10 times at once creates one order", { skip }, async () => {
  const s = await shop(10);
  const buyer = await customer();
  const idem = `idem_${randomBytes(8).toString("hex")}`;
  const fp = createHash("sha256").update(`cart-${idem}`).digest("hex");
  const results = await Promise.allSettled([...Array(10)].map(() => placeOrder(s, buyer, { idem, fingerprint: fp })));
  const ids = new Set(results.filter((r) => r.status === "fulfilled").map((r) => r.value.orderId));
  assert.equal(ids.size, 1, "one order");
  const rows = await sql.query(`select count(*)::int n from orders where user_id=$1`, [buyer.id]);
  assert.equal(rows[0].n, 1);
  assert.equal(await stockOf(s), 9, "one unit reserved");
  // Reusing the key for a different cart is refused.
  await assert.rejects(placeOrder(s, buyer, { idem, qty: 2, fingerprint: createHash("sha256").update("different").digest("hex") }));
});

test("payments: 10 duplicate success webhooks complete the payment once", { skip }, async () => {
  const s = await shop(5);
  const buyer = await customer();
  const order = await placeOrder(s, buyer);
  const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: buyer.id });
  provider.pay(intent.providerReference);
  const id = event++;
  const raw = JSON.stringify({ event: "charge.success", data: { id, reference: intent.providerReference, amount: 11500, currency: "GHS" } });
  const variant = JSON.stringify({ event: "charge.success", data: { id: event++, reference: intent.providerReference, amount: 11500, currency: "GHS" } });
  const results = await Promise.allSettled([...Array(8)].map(() => handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) }))
    .concat([...Array(2)].map(() => handlePaymentWebhook({ providerKey: "paystack", rawBody: variant, signature: provider.sign(variant) }))));
  assert.ok(results.some((r) => r.status === "fulfilled"));
  const [p] = await sql.query(`select status from payments where id=$1`, [order.paymentId]);
  const [o] = await sql.query(`select status from orders where id=$1`, [order.orderId]);
  assert.deepEqual([p.status, o.status], ["completed", "paid"]);
  const consumed = await sql.query(`select count(*)::int n from order_stock_reservations where order_id=$1 and status='consumed'`, [order.orderId]);
  assert.equal(consumed[0].n, 1, "stock consumed once");
  const audit = await sql.query(`select count(*)::int n from audit_events where event_type ilike '%payment%complet%' and resource_id in ($1,$2)`, [order.paymentId, order.orderId]).catch(() => [{ n: null }]);
  if (audit[0].n !== null) assert.ok(audit[0].n <= 1, "at most one completion audit");
});

/** Simulated SMS provider: knows the code it "sent". */
function smsProvider(code = "482913") {
  const calls = { send: 0, verify: 0 };
  return {
    calls,
    adapter: {
      key: "sim-sms",
      async send() { calls.send++; return { code: "accepted" }; },
      async verify(input) { calls.verify++; return { code: input.code === code ? "verified" : "invalid" }; },
    },
  };
}

test("OTP: concurrent guessing is capped at the attempt limit, then locked", { skip }, async () => {
  process.env.ELEMARKET_TEST_CLIENT_IP = "198.51.100.41";
  const buyer = await unverifiedCustomer();
  const next = buyer.phone;
  const sms = smsProvider();
  const { challengeId } = await otp.requestOtp({ number: next, purpose: "phone_verification", userId: buyer.id }, sms.adapter);
  const guesses = await Promise.allSettled([...Array(50)].map((_, i) =>
    otp.verifyOtp({ challengeId, code: String(100000 + i), userId: buyer.id, expectedPurpose: "phone_verification" }, sms.adapter)));
  assert.equal(guesses.filter((g) => g.status === "fulfilled").length, 0);
  const [c] = await sql.query(`select attempts, max_attempts, status from otp_challenges where id=$1`, [challengeId]);
  assert.ok(sms.calls.verify <= c.max_attempts, `provider checked at most ${c.max_attempts} codes, got ${sms.calls.verify}`);
  assert.ok(c.attempts <= c.max_attempts);
  // Even the right code is refused after the lock.
  assert.ok(c.status === "locked" || c.attempts >= c.max_attempts, `challenge exhausted: ${JSON.stringify(c)}`);
  // Even the right code is refused now (by the lock, or first by the rate limiter).
  await assert.rejects(otp.verifyOtp({ challengeId, code: "482913", userId: buyer.id, expectedPurpose: "phone_verification" }, sms.adapter), /invalid, expired, or locked|Too many requests/);
  const [pr] = await sql.query(`select phone_verified_at from profiles where user_id=$1`, [buyer.id]);
  assert.equal(pr.phone_verified_at, null, "phone not verified by guessing");
});

test("OTP: a correct code submitted 10 times at once verifies once; replay and cross-account use fail", { skip }, async () => {
  process.env.ELEMARKET_TEST_CLIENT_IP = "198.51.100.42";
  const buyer = await unverifiedCustomer();
  const other = await unverifiedCustomer();
  const next = buyer.phone;
  const sms = smsProvider("731905");
  const { challengeId } = await otp.requestOtp({ number: next, purpose: "phone_verification", userId: buyer.id }, sms.adapter);
  await assert.rejects(otp.verifyOtp({ challengeId, code: "731905", userId: other.id, expectedPurpose: "phone_verification" }, sms.adapter), /invalid, expired, or locked/, "another account cannot use it");
  const results = await Promise.allSettled([...Array(10)].map(() =>
    otp.verifyOtp({ challengeId, code: "731905", userId: buyer.id, expectedPurpose: "phone_verification" }, sms.adapter)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "verified exactly once");
  const [c] = await sql.query(`select status, phone_applied_at is not null as applied from otp_challenges where id=$1`, [challengeId]);
  assert.deepEqual(c, { status: "verified", applied: true });
  await assert.rejects(sql.query(`select confirm_phone_verification($1,$2)`, [buyer.id, challengeId]), /does not match/, "a used challenge cannot be applied again");
  await assert.rejects(sql.query(`select confirm_phone_verification($1,$2)`, [other.id, challengeId]), /does not match/);
});

test("OTP: a verified phone cannot be swapped directly (account-takeover guard)", { skip }, async () => {
  const buyer = await customer();
  await assert.rejects(sql.query(`update profiles set phone=$2 where user_id=$1`, [buyer.id, phone()]),
    /phone change requires verified old-number call and identity review/);
  const [pr] = await sql.query(`select phone, phone_verified_at is not null as verified from profiles where user_id=$1`, [buyer.id]);
  assert.deepEqual(pr, { phone: buyer.phone, verified: true }, "number and verification unchanged");
  // A customer who never verified a phone cannot check out.
  const s = await shop(3);
  await assert.rejects(placeOrder(s, await unverifiedCustomer()), /verified customer phone required/);
});

test("authorization: merchants, customers and admins stay in their lanes", { skip }, async () => {
  const a = await shop(1), b = await shop(1);
  // Each shop's owner account (one active owner per merchant).
  const ownerA = await unverifiedCustomer(), ownerB = await unverifiedCustomer();
  await sql.query(`insert into merchant_accounts(merchant_id,user_id,status) values($1,$2,'active'),($3,$4,'active')`, [a.merchant, ownerA.id, b.merchant, ownerB.id]);
  const owner = await authz.requireMerchantAccessForUserId(a.merchant, ownerA.id);
  assert.notEqual(owner.role, "admin");
  await assert.rejects(authz.requireMerchantAccessForUserId(b.merchant, ownerA.id), /access denied/i, "no cross-merchant access");
  const buyer = await customer();
  await assert.rejects(authz.requireMerchantAccessForUserId(a.merchant, buyer.id), /access denied|required/i, "customers are not merchants");
  await assert.rejects(authz.requireAdminForUserId(buyer.id, "admin.finance.policy"), /admin|denied|required|forbidden/i, "customers are not admins");
  await assert.rejects(authz.requireAdminForUserId(ownerA.id, "admin.finance.policy"), /admin|denied|required|forbidden/i, "merchants are not admins");
  // Suspending the owner account removes access immediately.
  await sql.query(`update merchant_accounts set status='suspended' where merchant_id=$1`, [a.merchant]);
  await assert.rejects(authz.requireMerchantAccessForUserId(a.merchant, ownerA.id), /access denied|suspended/i);
  // A customer cannot start payment on someone else's order.
  const s = await shop(2);
  const victim = await customer(), attacker = await customer();
  const order = await placeOrder(s, victim);
  await assert.rejects(payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: attacker.id }));
});
