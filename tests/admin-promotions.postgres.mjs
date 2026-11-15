// Marketplace (ELEMARKET-funded) promotions on REAL PostgreSQL (migration 0234).
// Money rules proven here:
//   * the customer pays less; merchant_net, the provider split to the merchant
//     and the wallet sale credit are identical to the same order without it;
//   * the discount per order is capped below that order's commission;
//   * the budget is reserved atomically, never exceeded under concurrency, and
//     released when the order expires unpaid or is cancelled;
//   * limits, pause/resume and merchant-funded promotions behave as before.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test npm run test:db:postgres
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";
import { quoteCartCanonical } from "../src/lib/commerce-guards.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
let db, harness, sql, promos, payments, wallet, handlePaymentWebhook, provider, event = 120_000;
const admin = `promo_admin_${randomBytes(4).toString("hex")}`;
const ADDRESS = "1 Test Street";

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url });
  provider = installPaymentProviderMock();
  harness = await startHarness();
  sql = harness.sql;
  promos = await harness.load("/src/modules/administration/internal/admin-promotions.server.ts");
  payments = await harness.load("/src/modules/payments/public/payment.server.ts");
  wallet = await harness.load("/src/modules/wallet/public/wallet.server.ts");
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));
  await sql.query(`insert into "user"(id,name,email,"emailVerified",role) values($1,$1,$2,true,'admin')`, [admin, `${admin}@example.test`]);
});
after(async () => {
  if (!enabled) return;
  provider?.restore();
  await harness?.close();
  await db?.drop();
});

// ------------------------------------------------------------------ helpers
const n = (v) => Number(v);
const tag = () => randomBytes(5).toString("hex");

/** A verified customer + active merchant whose product (GHS 100, 5% commission) has stock. */
async function shop() {
  const seed = await seedOrder(sql);
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
  await sql.query(`update product_variants set stock=1000 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=1000 where id=$1`, [seed.product]);
  return seed;
}

/** Another customer (verified phone) for an existing shop. */
async function customer() {
  const other = await seedOrder(sql);
  await sql.query(`update orders set status='cancelled' where id=$1`, [other.order]);
  return other.user;
}

/** Real create_pending_order(). `items` default: one unit of the seed variant. */
async function buy(seed, { promoCode = null, user = seed.user, items, query = (t, p) => sql.query(t, p) } = {}) {
  const lines = items ?? [{ productId: seed.product, variantId: seed.variant, quantity: 1 }];
  const t = tag();
  const fingerprint = createHash("sha256")
    .update(quoteCartCanonical({ merchantId: seed.merchant, address: ADDRESS, tier: "same_day", items: lines })).digest("hex");
  const quoteId = `q_${t}`;
  await query(
    `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,expires_at)
     values($1,$2,$3,$4,'same_day',15,60,1,$5,now()+interval '1 hour')`, [quoteId, user, seed.merchant, fingerprint, ADDRESS]);
  const [{ result }] = await query(
    `with identity as (select set_config('app.user_id',$1,true) u)
     select create_pending_order($1,$2,$3,$4::jsonb,$5::jsonb,$6,'mobile_money',$7) as result from identity`,
    [user, `idem_${t}_0123456789`, createHash("sha256").update(t).digest("hex"), JSON.stringify(lines),
      JSON.stringify([{ merchantId: seed.merchant, quoteId }]), ADDRESS, promoCode]);
  return result.orders[0];
}

async function pay(order, user) {
  const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: user });
  provider.pay(intent.providerReference);
  const raw = JSON.stringify({ event: "charge.success", data: { id: event++, reference: intent.providerReference, amount: Math.round(n(order.grandTotal) * 100), currency: "GHS" } });
  const res = await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
  assert.equal(res.status, "completed", JSON.stringify(res));
  return intent;
}

const orderRow = async (id) => (await sql.query(
  `select status, product_total::numeric, platform_fee::numeric, merchant_net::numeric, grand_total::numeric, delivery_total::numeric,
          promo_discount::numeric, platform_funded_discount::numeric, original_product_total::numeric, promo_id
     from orders where id=$1`, [id]))[0];
const budget = async (promotionId) => (await sql.query(
  `select max_discount_amount::numeric as max, reserved_discount_amount::numeric as reserved, consumed_discount_amount::numeric as consumed
     from promotion_budgets where promotion_id=$1`, [promotionId]))[0];
/** Customer cancels an unpaid order (the real path), keeping under the 3-unpaid-orders quota. */
const cancel = (order, user) => sql.query(
  `with identity as (select set_config('app.user_id',$2,true) u) select release_order_stock($1,$2) from identity`, [order.orderId, user]);
const redemption = async (orderId) => (await sql.query(`select status, discount_amount::numeric from promotion_redemptions where order_id=$1`, [orderId]))[0];

/** Create through the admin service, activate, and move the start into the past. */
async function marketplacePromo(overrides = {}) {
  const code = `MKT${tag().toUpperCase()}`;
  const now = Date.now();
  const { promotionId } = await promos.createMarketplacePromotion(admin, {
    code, name: "Marketplace test deal", description: null, discountType: "percentage", discountValue: "10",
    maxDiscount: null, minSubtotal: "0", usageLimit: null, perCustomerLimit: 5,
    startsAt: new Date(now).toISOString(), endsAt: new Date(now + 7 * 86_400e3).toISOString(),
    budget: "1000", firstOrderOnly: false, isPublic: true, categories: [], merchantIds: [], activate: true, ...overrides,
  });
  await sql.query(`update promotions set starts_at=now()-interval '1 minute' where id=$1`, [promotionId]);
  return { promotionId, code };
}

// ------------------------------------------------------------------ money

test("provider split, merchant_net and wallet credit are identical with and without a marketplace promotion", { skip }, async () => {
  const { promotionId, code } = await marketplacePromo();

  // Provider-split merchant (default settlement): compare what the provider routes to the subaccount.
  const split = await shop();
  const plain = await buy(split);
  const promo = await buy(split, { promoCode: code });
  const a = await orderRow(plain.orderId), b = await orderRow(promo.orderId);
  assert.deepEqual([n(a.product_total), n(a.platform_fee), n(a.merchant_net), n(a.grand_total)], [100, 5, 95, 115]);
  // 10% of 100 = 10, capped one pesewa below the GHS 5.00 commission.
  assert.deepEqual([n(b.product_total), n(b.platform_fee), n(b.merchant_net), n(b.grand_total)], [95.01, 0.01, 95, 110.01]);
  assert.equal(n(b.promo_discount), 4.99);
  assert.equal(n(b.platform_funded_discount), 4.99);
  assert.equal(n(b.original_product_total), 100);
  assert.equal(b.merchant_net, a.merchant_net, "merchant earnings unchanged");
  const [pa] = await sql.query(`select amount::numeric from payments where id=$1`, [promo.paymentId]);
  assert.equal(n(pa.amount), 110.01, "customer is charged the discounted grand total");

  const before = provider.initializeBodies.length;
  await pay(plain, split.user);
  await pay(promo, split.user);
  const [bodyPlain, bodyPromo] = provider.initializeBodies.slice(before);
  assert.equal(Number(bodyPlain.amount), 11500);
  assert.equal(Number(bodyPromo.amount), 11001);
  assert.equal(bodyPlain.transaction_charge, 500);
  assert.equal(bodyPromo.transaction_charge, 1, "explicit platform charge is always sent");
  assert.equal(Number(bodyPlain.amount) - bodyPlain.transaction_charge, Number(bodyPromo.amount) - bodyPromo.transaction_charge,
    "merchant subaccount receives the same amount");
  const snap = await sql.query(`select product_total::numeric, commission_amount::numeric from order_commission_snapshots where order_id=$1`, [promo.orderId]);
  assert.deepEqual(snap.map((r) => [n(r.product_total), n(r.commission_amount)]), [[100, 5]], "merchant commission basis unchanged");

  // Wallet-settled merchant: compare the ledger sale credit.
  const walletShop = await shop();
  await wallet.enableWalletForMerchant(walletShop.merchant, admin);
  const w1 = await buy(walletShop);
  const w2 = await buy(walletShop, { promoCode: code });
  await pay(w1, walletShop.user);
  await pay(w2, walletShop.user);
  const credits = await sql.query(
    `select order_id, amount::numeric from wallet_ledger_entries where entry_type='sale' and order_id = any($1::text[]) order by amount`,
    [[w1.orderId, w2.orderId]]);
  assert.equal(credits.length, 2);
  assert.deepEqual(credits.map((c) => n(c.amount)), [95, 95], "wallet sale credit identical");
  assert.equal((await redemption(w2.orderId)).status, "applied");

  const bud = await budget(promotionId);
  assert.equal(n(bud.consumed), 9.98, "two paid redemptions consumed");
  assert.equal(n(bud.reserved), 0);
});

test("a refund returns what the customer paid and claws back exactly merchant_net", { skip }, async () => {
  const { promotionId, code } = await marketplacePromo();
  const s = await shop();
  await wallet.enableWalletForMerchant(s.merchant, admin);
  const order = await buy(s, { promoCode: code });
  await pay(order, s.user);
  const [{ result }] = await sql.query(`select prepare_provider_refund_for_payment($1,$2) as result`, [order.paymentId, s.user]);
  const [req] = await sql.query(`select amount::numeric from provider_refund_requests where id=$1`, [result.requestId]);
  assert.equal(n(req.amount), 110.01, "refund = discounted grand total the customer paid");
  await sql.query(`update provider_refund_requests set status='processed', processed_at=now() where id=$1`, [result.requestId]);
  const [ledger] = await sql.query(
    `select coalesce(sum(amount) filter (where entry_type='sale'),0)::numeric as sale,
            coalesce(sum(amount) filter (where entry_type='refund'),0)::numeric as refund
       from wallet_ledger_entries where order_id=$1`, [order.orderId]);
  assert.deepEqual([n(ledger.sale), n(ledger.refund)], [95, -95], "merchant returns exactly what they were credited");
  // As for merchant promotions, a paid-then-refunded redemption stays used (anti refund/redeem abuse).
  assert.equal((await redemption(order.orderId)).status, "applied");
  assert.equal(n((await budget(promotionId)).consumed), 4.99);
});

test("discount = min(computed, max_discount, commission - 0.01), per merchant order", { skip }, async () => {
  const s = await shop();
  const fixed = await marketplacePromo({ discountType: "fixed", discountValue: "2" });
  const capped = await marketplacePromo({ discountType: "percentage", discountValue: "50", maxDiscount: "1.50" });
  const big = await marketplacePromo({ discountType: "fixed", discountValue: "80" });
  const b1 = await buy(s, { promoCode: fixed.code });
  const o1 = await orderRow(b1.orderId);
  assert.deepEqual([n(o1.promo_discount), n(o1.platform_fee), n(o1.merchant_net), n(o1.grand_total)], [2, 3, 95, 113]);
  const b2 = await buy(s, { promoCode: capped.code });
  const o2 = await orderRow(b2.orderId);
  assert.deepEqual([n(o2.promo_discount), n(o2.platform_fee), n(o2.merchant_net)], [1.5, 3.5, 95]);
  await cancel(b1, s.user);
  await cancel(b2, s.user);
  // Three units: commission 15.00, so an GHS 80 voucher gives 14.99.
  const b3 = await buy(s, { promoCode: big.code, items: [{ productId: s.product, variantId: s.variant, quantity: 3 }] });
  const o3 = await orderRow(b3.orderId);
  assert.deepEqual([n(o3.product_total), n(o3.promo_discount), n(o3.platform_fee), n(o3.merchant_net), n(o3.grand_total)], [285.01, 14.99, 0.01, 285, 300.01]);
  await cancel(b3, s.user);

  // A product with zero commission leaves nothing for ELEMARKET to fund.
  await sql.query(`insert into commission_rules(scope_type,scope_id,rate_bps) values('product',$1,0)`, [s.product]);
  await assert.rejects(buy(s, { promoCode: fixed.code }), /promotion does not apply to this cart/);
  await sql.query(`delete from commission_rules where scope_type='product' and scope_id=$1`, [s.product]);
});

test("budget is never exceeded by 10 concurrent checkouts", { skip }, async () => {
  // Each order gets 4.99; a 14.97 budget fits exactly three.
  const { promotionId, code } = await marketplacePromo({ budget: "14.97", perCustomerLimit: 1 });
  const shops = [];
  for (let i = 0; i < 10; i++) shops.push(await shop());
  const clients = await Promise.all(shops.map(async () => { const c = new pg.Client({ connectionString: db.url }); await c.connect(); return c; }));
  try {
    const results = await Promise.allSettled(shops.map((s, i) =>
      buy(s, { promoCode: code, query: (t, p) => clients[i].query(t, p).then((r) => r.rows) })));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 3, failed.map((f) => f.reason?.message).join(" | "));
    for (const f of failed) assert.match(f.reason.message, /promotion budget exhausted/);
    const bud = await budget(promotionId);
    assert.equal(n(bud.reserved), 14.97);
    assert.ok(n(bud.reserved) + n(bud.consumed) <= n(bud.max));
    const [{ count }] = await sql.query(`select count(*)::int from promotion_redemptions where promotion_id=$1 and status='reserved'`, [promotionId]);
    assert.equal(count, 3);
  } finally {
    await Promise.all(clients.map((c) => c.end()));
  }
  // The table CHECK is the last line of defence even if checkout were bypassed.
  await assert.rejects(
    sql.query(`update promotion_budgets set reserved_discount_amount=reserved_discount_amount+0.01 where promotion_id=$1`, [promotionId]),
    /promotion_budgets_check/);
});

test("budget is released when the order expires unpaid or is cancelled, and consumed when paid", { skip }, async () => {
  const { promotionId, code } = await marketplacePromo({ budget: "4.99", perCustomerLimit: 10 });
  const s = await shop();
  const first = await buy(s, { promoCode: code });
  assert.equal(n((await budget(promotionId)).reserved), 4.99);
  await assert.rejects(buy(s, { promoCode: code }), /promotion budget exhausted/);

  // Payment deadline passes with no attempt: the expiry job cancels the order.
  await sql.query(`update orders set payment_deadline=now()-interval '1 minute' where id=$1`, [first.orderId]);
  await sql.query(`select expire_payment_pending_orders(100)`);
  assert.equal((await orderRow(first.orderId)).status, "cancelled");
  assert.equal((await redemption(first.orderId)).status, "released");
  assert.deepEqual([n((await budget(promotionId)).reserved), n((await budget(promotionId)).consumed)], [0, 0]);

  // Customer cancels an unpaid order.
  const second = await buy(s, { promoCode: code });
  await cancel(second, s.user);
  assert.equal((await redemption(second.orderId)).status, "released");
  assert.equal(n((await budget(promotionId)).reserved), 0);

  // Paid: moves to consumed and stays consumed.
  const third = await buy(s, { promoCode: code });
  await pay(third, s.user);
  const bud = await budget(promotionId);
  assert.deepEqual([n(bud.reserved), n(bud.consumed)], [0, 4.99]);
  await assert.rejects(buy(s, { promoCode: code }), /promotion budget exhausted/);

  // A refused pay-on-delivery order releases an APPLIED redemption
  // (cancel_unpaid_pay_on_delivery_order runs exactly this statement).
  await sql.query(`update promotion_redemptions set status='released', released_at=now() where order_id=$1 and status='applied'`, [third.orderId]);
  assert.deepEqual([n((await budget(promotionId)).reserved), n((await budget(promotionId)).consumed)], [0, 0]);
});

test("per-customer limit, usage limit, first-order-only and minimum basket", { skip }, async () => {
  const s = await shop();
  const once = await marketplacePromo({ perCustomerLimit: 1 });
  const o = await buy(s, { promoCode: once.code });
  await assert.rejects(buy(s, { promoCode: once.code }), /promotion customer limit reached/);
  await cancel(o, s.user);
  await buy(s, { promoCode: once.code }); // released redemption frees the customer's use

  const capped = await marketplacePromo({ usageLimit: 1 });
  await buy(s, { promoCode: capped.code });
  const other = await customer();
  await assert.rejects(buy(s, { promoCode: capped.code, user: other }), /promotion usage limit reached/);

  const firstOrder = await marketplacePromo({ firstOrderOnly: true });
  const paid = await buy(s);
  await pay(paid, s.user);
  await assert.rejects(buy(s, { promoCode: firstOrder.code }), /new customers only/);
  const fresh = await customer();
  assert.equal(n((await buy(s, { promoCode: firstOrder.code, user: fresh })).promoDiscount), 4.99);

  const minBasket = await marketplacePromo({ minSubtotal: "150" });
  await assert.rejects(buy(s, { promoCode: minBasket.code, user: fresh }), /minimum basket/);
  const two = await buy(s, { promoCode: minBasket.code, user: fresh, items: [{ productId: s.product, variantId: s.variant, quantity: 2 }] });
  assert.equal(n(two.promoDiscount), 9.99);
});

test("merchant and category scope", { skip }, async () => {
  const inScope = await shop();
  const outScope = await shop();
  const byMerchant = await marketplacePromo({ merchantIds: [inScope.merchant] });
  assert.equal(n((await buy(inScope, { promoCode: byMerchant.code })).promoDiscount), 4.99);
  await assert.rejects(buy(outScope, { promoCode: byMerchant.code }), /not valid for this merchant/);

  const byCategory = await marketplacePromo({ categories: ["groceries"] });
  await assert.rejects(buy(inScope, { promoCode: byCategory.code }), /does not apply to this cart/);
  await sql.query(`update products set category='groceries' where id=$1`, [outScope.product]);
  assert.equal(n((await buy(outScope, { promoCode: byCategory.code })).promoDiscount), 4.99);
});

test("a paused marketplace promotion is rejected at checkout and works again after resume", { skip }, async () => {
  const s = await shop();
  const { promotionId, code } = await marketplacePromo();
  await promos.setMarketplacePromotionPaused(admin, { promotionId, paused: true, reason: "Fraud spike under review" });
  await assert.rejects(buy(s, { promoCode: code }), /promotion is not available/);
  await promos.setMarketplacePromotionPaused(admin, { promotionId, paused: false, reason: "Review finished, safe to run" });
  assert.equal(n((await buy(s, { promoCode: code })).promoDiscount), 4.99);
  const events = await sql.query(`select event_type, actor_user_id, metadata->>'reason' as reason from audit_events where resource_id=$1 order by id`, [promotionId]);
  assert.deepEqual(events.map((e) => e.event_type), [
    "admin.promotion.marketplace.created", "admin.promotion.marketplace.paused", "admin.promotion.marketplace.resumed"]);
  assert.ok(events.every((e) => e.actor_user_id === admin));
});

test("after start only a shorter end and a bigger budget can change — in the service and in the database", { skip }, async () => {
  const { promotionId, code } = await marketplacePromo({ budget: "100" });
  const [row] = await promos.listMarketplacePromotions().then((rows) => rows.filter((r) => r.id === promotionId));
  const base = {
    promotionId, code, name: row.name, description: row.description, discountType: row.discount_type, discountValue: row.discount_value,
    maxDiscount: row.max_discount, minSubtotal: row.min_subtotal, usageLimit: row.usage_limit, perCustomerLimit: row.per_customer_limit,
    startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(), budget: row.budget,
    firstOrderOnly: row.first_order_only, isPublic: row.is_public, categories: row.categories, merchantIds: row.merchant_ids,
  };
  await assert.rejects(promos.updateMarketplacePromotion(admin, { ...base, discountValue: "20" }), /Only a shorter end date or a larger budget/);
  await assert.rejects(promos.updateMarketplacePromotion(admin, { ...base, budget: "50" }), /can only be increased/);
  await assert.rejects(promos.updateMarketplacePromotion(admin, { ...base, endsAt: new Date(Date.now() + 30 * 86_400e3).toISOString() }), /brought forward/);
  const shorter = new Date(Date.now() + 86_400e3).toISOString();
  await promos.updateMarketplacePromotion(admin, { ...base, budget: "250", endsAt: shorter });
  assert.equal(n((await budget(promotionId)).max), 250);
  // Direct SQL cannot change money terms or scope of a started marketplace promotion.
  await assert.rejects(sql.query(`update promotions set discount_value=50 where id=$1`, [promotionId]), /started marketplace promotion/);
  await assert.rejects(sql.query(`update promotions set ends_at=ends_at+interval '30 days' where id=$1`, [promotionId]), /started marketplace promotion/);
  await assert.rejects(sql.query(`insert into promotion_categories(promotion_id,category) values($1,'food')`, [promotionId]), /started marketplace promotion/);
  await assert.rejects(sql.query(`update promotions set funding_source='merchant' where id=$1`, [promotionId]), /funding source cannot change/);
  // Merchants have nothing to "join": ELEMARKET funds it.
  const m = await shop();
  await assert.rejects(sql.query(`select set_merchant_promotion_participation($1,$2,true,$3)`, [promotionId, m.merchant, m.user]), /need no merchant participation/);
  // Budget below what is already used is refused by the database.
  const s = await shop();
  await buy(s, { promoCode: code });
  await assert.rejects(sql.query(`update promotion_budgets set max_discount_amount=1 where promotion_id=$1`, [promotionId]), /promotion_budgets_check/);

  // Before start, everything is editable.
  const later = await promos.createMarketplacePromotion(admin, {
    code: `LATER${tag().toUpperCase()}`, name: "Next week", discountType: "fixed", discountValue: "3", minSubtotal: "0",
    perCustomerLimit: 1, startsAt: new Date(Date.now() + 86_400e3).toISOString(), endsAt: new Date(Date.now() + 3 * 86_400e3).toISOString(),
    budget: "40", firstOrderOnly: false, isPublic: false, categories: [], merchantIds: [], activate: false,
  });
  await promos.updateMarketplacePromotion(admin, {
    promotionId: later.promotionId, code: `LATER${tag().toUpperCase()}`, name: "Next week (edited)", discountType: "percentage",
    discountValue: "15", maxDiscount: "4", minSubtotal: "20", usageLimit: 100, perCustomerLimit: 2,
    startsAt: new Date(Date.now() + 2 * 86_400e3).toISOString(), endsAt: new Date(Date.now() + 4 * 86_400e3).toISOString(),
    budget: "30", firstOrderOnly: true, isPublic: true, categories: ["electronics"], merchantIds: [s.merchant],
  });
  const [edited] = await sql.query(`select discount_type, discount_value::numeric, status from promotions where id=$1`, [later.promotionId]);
  assert.deepEqual([edited.discount_type, n(edited.discount_value), edited.status], ["percentage", 15, "draft"]);
  await assert.rejects(promos.createMarketplacePromotion(admin, {
    code: code.toLowerCase(), name: "Duplicate", discountType: "fixed", discountValue: "1", minSubtotal: "0", perCustomerLimit: 1,
    startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400e3).toISOString(), budget: "10",
    firstOrderOnly: false, isPublic: false, categories: [], merchantIds: [], activate: true,
  }), /already in use/);
});

// ------------------------------------------------------------------ merchant promotions

test("merchant-funded promotions behave exactly as before (discount comes out of the merchant's sale)", { skip }, async () => {
  const s = await shop();
  const code = `MER${tag().toUpperCase()}`;
  await sql.query(
    `insert into promotions(id,merchant_id,code,name,discount_type,discount_value,starts_at,ends_at,status,created_by)
     values($1,$2,$3,'Merchant deal','percentage',10,now()-interval '1 hour',now()+interval '1 day','active','merchant')`,
    [`promo_m_${tag()}`, s.merchant, code]);
  const o = await orderRow((await buy(s, { promoCode: code })).orderId);
  assert.deepEqual([n(o.product_total), n(o.platform_fee), n(o.merchant_net), n(o.grand_total), n(o.promo_discount), n(o.platform_funded_discount)],
    [90, 4.5, 85.5, 105, 10, 0]);

  // Legacy global (merchant_id NULL) promotion: still merchant-funded, no budget row needed.
  const global = `GLB${tag().toUpperCase()}`;
  await sql.query(
    `insert into promotions(id,code,name,discount_type,discount_value,starts_at,ends_at,status,created_by)
     values($1,$2,'Global merchant-funded','fixed',20,now()-interval '1 hour',now()+interval '1 day','active','simulation')`,
    [`promo_g_${tag()}`, global]);
  const g = await orderRow((await buy(s, { promoCode: global })).orderId);
  assert.deepEqual([n(g.product_total), n(g.platform_fee), n(g.merchant_net), n(g.promo_discount), n(g.platform_funded_discount)], [80, 4, 76, 20, 0]);
});

test("admins can hold and release a merchant promotion or flash sale, with a reason, without editing it", { skip }, async () => {
  const s = await shop();
  const code = `HOLD${tag().toUpperCase()}`;
  const id = `promo_h_${tag()}`;
  await sql.query(
    `insert into promotions(id,merchant_id,code,name,discount_type,discount_value,starts_at,ends_at,status,created_by)
     values($1,$2,$3,'Merchant hold test','fixed',5,now()-interval '1 hour',now()+interval '1 day','active','merchant')`,
    [id, s.merchant, code]);
  await assert.rejects(promos.setMerchantPromotionHold(admin, { kind: "coupon", id, paused: true, reason: "no" }), /reason/);
  await promos.setMerchantPromotionHold(admin, { kind: "coupon", id, paused: true, reason: "Misleading discount claim" });
  await assert.rejects(buy(s, { promoCode: code }), /promotion is not available/);
  // Nothing but an admin resume can lift the hold.
  await assert.rejects(sql.query(`update promotions set status='active' where id=$1`, [id]), /promotions_admin_pause_check/);
  const listed = (await promos.listMerchantPromotionsForAdmin({ search: code })).find((r) => r.id === id);
  assert.equal(listed.admin_pause_reason, "Misleading discount claim");
  await promos.setMerchantPromotionHold(admin, { kind: "coupon", id, paused: false, reason: "Merchant corrected the listing" });
  const resumed = await buy(s, { promoCode: code });
  assert.equal(n(resumed.promoDiscount), 5);
  await cancel(resumed, s.user);
  const [terms] = await sql.query(`select discount_type, discount_value::numeric, status from promotions where id=$1`, [id]);
  assert.deepEqual([terms.discount_type, n(terms.discount_value), terms.status], ["fixed", 5, "active"]);

  // Flash sale: paused sale no longer discounts; resume restores it.
  const fs = `fs_${tag()}`;
  await sql.query(`insert into flash_sales(id,merchant_id,name,status,starts_at,ends_at,created_by) values($1,$2,'Flash test','draft',now()-interval '1 hour',now()+interval '1 day','merchant')`, [fs, s.merchant]);
  await sql.query(`insert into flash_sale_items(flash_sale_id,product_id,variant_id,reference_price,sale_price) values($1,$2,$3,100,80)`, [fs, s.product, s.variant]);
  await sql.query(`update flash_sales set status='active' where id=$1`, [fs]);
  const flashOrder = async () => { const o = await buy(s); await cancel(o, s.user); return n(o.productTotal); };
  assert.equal(await flashOrder(), 80);
  await promos.setMerchantPromotionHold(admin, { kind: "flash_sale", id: fs, paused: true, reason: "Reference price looks inflated" });
  assert.equal(await flashOrder(), 100, "held flash sale gives no discount");
  await promos.setMerchantPromotionHold(admin, { kind: "flash_sale", id: fs, paused: false, reason: "Price history verified" });
  assert.equal(await flashOrder(), 80);
  await sql.query(`update flash_sales set status='ended' where id=$1`, [fs]);

  // Admins cannot use the merchant tools on a marketplace promotion and vice versa.
  const mkt = await marketplacePromo();
  await assert.rejects(promos.setMerchantPromotionHold(admin, { kind: "coupon", id: mkt.promotionId, paused: true, reason: "Wrong tool used" }), /not found/);
  await assert.rejects(promos.setMarketplacePromotionPaused(admin, { promotionId: id, paused: true, reason: "Wrong tool used" }), /not found/);
  const events = await sql.query(`select event_type from audit_events where resource_id in ($1,$2) order by id`, [id, fs]);
  assert.deepEqual(events.map((e) => e.event_type), [
    "admin.promotion.merchant.paused", "admin.promotion.merchant.resumed", "admin.flash_sale.paused", "admin.flash_sale.resumed"]);
});

test("reporting shows redemptions, discount given and budget used/remaining", { skip }, async () => {
  const { promotionId, code } = await marketplacePromo({ budget: "20" });
  const s = await shop();
  const paid = await buy(s, { promoCode: code });
  await pay(paid, s.user);
  await buy(s, { promoCode: code });
  const cancelled = await buy(s, { promoCode: code });
  await cancel(cancelled, s.user);
  const row = (await promos.listMarketplacePromotions()).find((r) => r.id === promotionId);
  assert.equal(row.phase, "live");
  assert.deepEqual([row.redemptions_applied, row.redemptions_reserved, row.redemptions_released], [1, 1, 1]);
  assert.deepEqual([n(row.discount_given), n(row.budget), n(row.budget_consumed), n(row.budget_reserved), n(row.budget_remaining)], [4.99, 20, 4.99, 4.99, 10.02]);
  const deals = await promos.listPublicDeals();
  assert.ok(deals.some((d) => d.code === code));
  assert.ok(!("budget" in deals[0]), "public deals never expose budgets");
});
