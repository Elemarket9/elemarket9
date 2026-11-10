// Merchant wallet adversarial suite (T01–T30) on REAL PostgreSQL.
//
// Real server code, real migrations, real multi-connection concurrency and
// separate worker processes. Payout providers are SIMULATED adapters
// (scripts/helpers/mock-payout-provider.mjs) whose "provider side" lives in the
// test database, so crashes and competing processes see one provider.
//
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test npm run test:wallet:postgres
// Optional: ELEMARKET_TEST_PG_RESTART_CMD="<command that restarts the server>" enables T22.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { checkout, configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";
import { deliverWithRiderOtp } from "../scripts/helpers/delivery-fixture.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
const mockPath = path.resolve("scripts/helpers/mock-payout-provider.mjs");
const HOURS = 3600e3;
// Earnings mature once the faulty-item return window (7 days by policy) has closed.
const MATURED = 7 * 24 + 2;

let db, harness, sql, wallet, payments, handlePaymentWebhook, provider, sim, authz;
let event = 70_000, keySeq = 0;
const key = () => `adv-${process.pid}-${String(++keySeq).padStart(10, "0")}`;

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({
    DATABASE_URL: db.url,
    SIM_PROVIDER_DATABASE_URL: db.url,
    ELEMARKET_PAYOUT_DRIVER: "mocka",
    ELEMARKET_PAYOUT_DRIVER_MOCKA_MODULE: mockPath,
    ELEMARKET_PAYOUT_DRIVER_MOCKB_MODULE: mockPath,
    ELEMARKET_PAYOUT_DRIVER_MOCKC_MODULE: mockPath,
    ELEMARKET_PAYOUT_ALLOWED_MODULES: mockPath,
    // mocka: idempotent + status lookup + webhooks + listing (best case)
    SIM_PAYOUT_MOCKA_CAPS: "idempotent,lookup,webhooks,listing,validation",
    // mockb: status lookup, but a resend is NOT de-duplicated
    SIM_PAYOUT_MOCKB_CAPS: "lookup,webhooks,validation",
    // mockc: webhooks only, no lookup, no idempotency (weakest)
    SIM_PAYOUT_MOCKC_CAPS: "webhooks,validation",
    ELEMARKET_WALLET_DESTINATION_COOLDOWN_HOURS: "0",
    ELEMARKET_WALLET_MIN_WITHDRAWAL: "1",
    ELEMARKET_WALLET_DAILY_WITHDRAWAL_COUNT: "1000",
    ELEMARKET_WALLET_DAILY_WITHDRAWAL_AMOUNT: "10000000",
    ELEMARKET_PAYOUT_FEE_FLAT: "1.00",
  });
  ({ simulatedProvider: sim } = await import(mockPath));
  provider = installPaymentProviderMock();
  harness = await startHarness();
  sql = harness.sql;
  payments = await harness.load("/src/modules/payments/public/payment.server.ts");
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));
  wallet = await harness.load("/src/modules/wallet/public/wallet.server.ts");
  authz = await harness.load("/src/modules/identity/public/auth/authorization.server.ts");
});

after(async () => {
  if (!enabled) return;
  provider?.restore();
  await sim?.close();
  await harness?.close();
  await db?.drop();
});

// ---------------------------------------------------------------- helpers
const selectDriver = (k) => { process.env.ELEMARKET_PAYOUT_DRIVER = k; };

async function newMerchant(driver = "mocka") {
  selectDriver(driver);
  const seed = await seedOrder(sql);
  await sql.query(`update product_variants set stock=1000 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=1000 where id=$1`, [seed.product]);
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
  await wallet.enableWalletForMerchant(seed.merchant, "admin_sim");
  const dest = await wallet.registerPayoutDestination({
    merchantId: seed.merchant, rail: "mobile_money", accountNumber: `+2332${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    institutionCode: "MTN", accountName: "Adversarial Merchant", actorUserId: seed.user });
  return { ...seed, destination: dest.destinationId, driver };
}

/** Customer pays (simulated provider), rider OTP handover at `deliveredHoursAgo`, then release. */
async function earn(m, { deliveredHoursAgo = MATURED, release = true } = {}) {
  const order = await checkout(sql, m);
  const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: m.user });
  provider.pay(intent.providerReference);
  const raw = JSON.stringify({ event: "charge.success", data: { id: event++, reference: intent.providerReference, amount: Math.round(Number(order.grandTotal) * 100), currency: "GHS" } });
  await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
  if (deliveredHoursAgo !== null) await deliverWithRiderOtp(sql, { orderId: order.orderId, at: new Date(Date.now() - deliveredHoursAgo * HOURS) });
  if (release) await sql.query(`select release_matured_wallet_funds(1000)`);
  return order;
}

async function balances(m) {
  const [b] = await sql.query(
    `select total_sales::numeric, refunded::numeric, withheld::numeric, available::numeric, processing::numeric,
            paid_out::numeric, payout_fees::numeric, recovery_due::numeric from merchant_wallet_balances where merchant_id=$1`, [m.merchant]);
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Number(v)]));
}
async function assertInvariants(m) {
  const b = await balances(m);
  for (const k of ["withheld", "available", "processing", "paid_out", "payout_fees", "recovery_due"]) assert.ok(b[k] >= 0, `${k} must not be negative: ${b[k]}`);
  assert.equal(Math.round((b.withheld + b.available + b.processing + b.paid_out + b.payout_fees - b.recovery_due) * 100),
    Math.round((b.total_sales - b.refunded) * 100), "every cedi in exactly one bucket");
  return b;
}
/** Reserve a withdrawal WITHOUT the immediate send, so workers can compete for it. */
async function reserve(m, amount) {
  const quote = await wallet.quoteWithdrawal({ merchantId: m.merchant, amount, destinationId: m.destination });
  const [r] = await sql.query(`select wallet_request_payout($1,$2::numeric,$3::numeric,$4,$5,$6,$7,$8::jsonb) as result`,
    [m.merchant, quote.amount, quote.fee, m.destination, quote.driverKey, key(), m.user, JSON.stringify(wallet.withdrawalLimits())]);
  return r.result.payoutId;
}
const request = (m, amount, idempotencyKey = key()) =>
  wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount, destinationId: m.destination, idempotencyKey });
const payout = async (id) => (await sql.query(`select * from wallet_payouts where id=$1`, [id]))[0];
const sends = async (id) => (await sql.query(`select count(*)::int as n from wallet_payout_attempts where payout_id=$1 and kind='send'`, [id]))[0].n;
const due = (id) => sql.query(`update wallet_payouts set next_attempt_at=now(), lease_until=null, updated_at=now()-interval '5 minutes' where id=$1`, [id]);
const ledgerCount = async (id, type) => (await sql.query(`select count(*)::int as n from wallet_ledger_entries where payout_id=$1 and entry_type=$2`, [id, type]))[0].n;
const exceptions = async (id) => (await sql.query(`select kind from wallet_reconciliation_exceptions where payout_id=$1 order by id`, [id])).map((r) => r.kind);
/** A notification signed by the provider that handled the payout. */
const webhook = async (raw) => {
  const [p] = await sql.query(`select driver_key from wallet_payouts where id=$1`, [JSON.parse(raw).payoutId]);
  return wallet.handlePayoutWebhook({ rawBody: raw, headers: new Headers({ "x-sim-signature": sim.signWebhook(raw, p.driver_key) }) });
};

function worker(job) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/helpers/wallet-worker.mjs", JSON.stringify(job)], { env: { ...process.env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => {
      const line = out.split("\n").reverse().find((l) => l.startsWith("{\"ok\""));
      resolve({ code, ...(line ? JSON.parse(line) : {}), crashed: code === 137, stderr: err.slice(-400) });
    });
  });
}

// ---------------------------------------------------------------- tests
test("T01 double-click withdrawal is one logical request", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const k = key();
  const a = await request(m, "20.00", k);
  const b = await request(m, "20.00", k);
  assert.equal(a.payoutId, b.payoutId);
  assert.equal(b.replay, true);
  assert.equal((await sql.query(`select count(*)::int n from wallet_payouts where merchant_id=$1`, [m.merchant]))[0].n, 1);
  assert.equal((await sim.transfers(a.payoutId)).length, 1);
  await assertInvariants(m);
});

test("T02 100 identical concurrent requests are one logical request", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const k = key();
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => request(m, "30.00", k)));
  const ids = new Set(results.filter((r) => r.status === "fulfilled").map((r) => r.value.payoutId));
  assert.equal(ids.size, 1, "exactly one withdrawal");
  assert.ok(results.filter((r) => r.status === "fulfilled").length >= 90, "requests are answered, not dropped");
  assert.equal((await sql.query(`select count(*)::int n from wallet_payouts where merchant_id=$1`, [m.merchant]))[0].n, 1);
  assert.equal((await sim.transfers([...ids][0])).length, 1, "one provider transfer");
  await assertInvariants(m);
});

test("T03 20 competing withdrawals never over-reserve", { skip }, async () => {
  const m = await newMerchant(); await earn(m); await earn(m);
  const before = await balances(m);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => request(m, "60.00")));
  const accepted = results.filter((r) => r.status === "fulfilled");
  assert.equal(accepted.length, 1, "one reservation at a time");
  for (const r of results.filter((r) => r.status === "rejected")) assert.match(r.reason.message, /already in progress|exceeds available/);
  const b = await assertInvariants(m);
  assert.equal(b.available, before.available - 60);
});

test("T04 two devices (two processes) create no duplicate payout", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const startAt = Date.now() + 9000;
  const runs = await Promise.all([1, 2].map(() => worker({ action: "request", startAt,
    input: { merchantId: m.merchant, userId: m.user, amount: "40.00", destinationId: m.destination, idempotencyKey: key() } })));
  assert.equal(runs.filter((r) => r.ok).length, 1, JSON.stringify(runs.map((r) => r.error ?? r.result?.status)));
  assert.match(runs.find((r) => !r.ok).error, /already in progress/);
  const rows = await sql.query(`select id from wallet_payouts where merchant_id=$1`, [m.merchant]);
  assert.equal(rows.length, 1);
  assert.equal((await sim.transfers(rows[0].id)).length, 1);
  await assertInvariants(m);
});

test("T05 two backend workers never execute the same payout twice", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const id = await reserve(m, "50.00");
  const startAt = Date.now() + 9000;
  const runs = await Promise.all([1, 2].map(() => worker({ action: "dispatch", payoutId: id, startAt })));
  assert.ok(runs.every((r) => r.ok), JSON.stringify(runs));
  const handled = runs.filter((r) => Object.keys(r.result).length === 1);
  assert.equal(handled.length, 1, "exactly one worker claimed it");
  assert.equal(await sends(id), 1);
  assert.equal((await sim.transfers(id)).length, 1);
});

test("T06 provider timeout: no blind retry (read back first; quarantine if resend is unsafe)", { skip }, async () => {
  // Idempotent provider: read back, not found, resend under the same key.
  const a = await newMerchant("mocka"); await earn(a);
  await sim.injectFault("mocka", "create", "timeout_before");
  const r = await request(a, "25.00");
  assert.equal(r.status, "uncertain", "a timeout is never treated as failure");
  assert.equal((await balances(a)).processing, 25, "funds stay reserved");
  await due(r.payoutId); await wallet.dispatchPayouts({ payoutId: r.payoutId });
  const kinds = (await sql.query(`select kind, outcome from wallet_payout_attempts where payout_id=$1 order by attempt_no`, [r.payoutId])).map((x) => `${x.kind}:${x.outcome}`);
  assert.deepEqual(kinds, ["send:uncertain", "lookup:not_found", "send:accepted"], "read back before the resend");
  assert.equal((await sim.transfers(r.payoutId)).length, 1);
  // Non-idempotent provider: a resend could pay twice, so it is quarantined instead.
  const b = await newMerchant("mockb"); await earn(b);
  await sim.injectFault("mockb", "create", "timeout_before");
  const rb = await request(b, "25.00");
  await due(rb.payoutId); await wallet.dispatchPayouts({ payoutId: rb.payoutId });
  assert.equal((await payout(rb.payoutId)).status, "needs_attention");
  assert.equal(await sends(rb.payoutId), 1, "never re-sent");
  assert.equal((await balances(b)).processing, 25, "reservation kept until non-payment is established");
  selectDriver("mocka");
});

test("T07 provider accepts but the response is lost: no second payout", { skip }, async () => {
  for (const drv of ["mocka", "mockb"]) {
    const m = await newMerchant(drv); await earn(m);
    await sim.injectFault(drv, "create", "timeout_after");
    const r = await request(m, "35.00");
    assert.equal(r.status, "uncertain");
    await due(r.payoutId); await wallet.dispatchPayouts({ payoutId: r.payoutId });
    assert.equal((await payout(r.payoutId)).status, "processing", `${drv}: found by read-back`);
    assert.equal((await sim.transfers(r.payoutId)).length, 1, `${drv}: exactly one transfer`);
    assert.equal(await sends(r.payoutId), 1);
  }
  selectDriver("mocka");
});

test("T08 server crash after submission recovers safely", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const id = await reserve(m, "45.00");
  await sim.injectFault("mocka", "create", "crash_after");
  const crashed = await worker({ action: "dispatch", payoutId: id });
  assert.equal(crashed.crashed, true, `worker must crash: ${crashed.stderr}`);
  const mid = await payout(id);
  assert.equal(mid.status, "submitting", "durable evidence that a send was in flight");
  assert.equal((await sql.query(`select outcome from wallet_payout_attempts where payout_id=$1`, [id]))[0].outcome, "pending");
  await due(id);
  const recovered = await worker({ action: "dispatch", payoutId: id });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal((await payout(id)).status, "processing");
  assert.equal((await sim.transfers(id)).length, 1, "no second transfer");
  assert.equal(await sends(id), 1);
});

test("T09 duplicate success callbacks settle the ledger once", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const r = await request(m, "30.00");
  await sim.finish(r.payoutId, "paid");
  const raw = JSON.stringify({ payoutId: r.payoutId, providerReference: (await sim.transfers(r.payoutId))[0].reference });
  const raw2 = JSON.stringify({ providerReference: (await sim.transfers(r.payoutId))[0].reference, payoutId: r.payoutId });
  const results = await Promise.allSettled([...Array(10)].map(() => webhook(raw)).concat([...Array(10)].map(() => webhook(raw2))));
  assert.ok(results.every((x) => x.status === "fulfilled"), JSON.stringify(results.find((x) => x.status === "rejected")?.reason?.message));
  assert.equal((await payout(r.payoutId)).status, "paid");
  assert.equal(await ledgerCount(r.payoutId, "payout_paid"), 2, "one settlement pair");
  assert.equal(await ledgerCount(r.payoutId, "payout_fee"), 1);
  assert.equal((await sql.query(`select count(*)::int n from wallet_payout_events where payout_id=$1`, [r.payoutId]))[0].n, 2, "two distinct payloads stored once each");
  await assertInvariants(m);
});

test("T10 conflicting callbacks are reconciled, never silently applied", { skip }, async () => {
  const m = await newMerchant("mockc"); await earn(m); // webhook-only provider
  const r = await request(m, "30.00");
  assert.equal(r.status, "processing");
  const ref = (await sim.transfers(r.payoutId))[0].reference;
  await webhook(JSON.stringify({ payoutId: r.payoutId, providerReference: ref, status: "paid" }));
  await webhook(JSON.stringify({ payoutId: r.payoutId, providerReference: ref, status: "failed" }));
  await webhook(JSON.stringify({ payoutId: r.payoutId, providerReference: ref, status: "processing" }));
  assert.equal((await payout(r.payoutId)).status, "paid", "a final state is never reversed by a later message");
  assert.deepEqual(await exceptions(r.payoutId), ["failure_after_success"]);
  assert.equal(await ledgerCount(r.payoutId, "payout_returned"), 0, "no funds released on the conflicting report");
  await assertInvariants(m);
  selectDriver("mocka");
});

test("T11 repeated delivery completion releases earnings once", { skip }, async () => {
  const m = await newMerchant();
  const order = await earn(m, { release: false });
  await Promise.all([...Array(10)].map(() => sql.query(`select release_matured_wallet_funds(1000)`)));
  const rel = await sql.query(`select count(*)::int n from wallet_ledger_entries where order_id=$1 and entry_type='release' and bucket='withheld'`, [order.orderId]);
  assert.equal(rel[0].n, 1, "one release entry for the order");
  await assertInvariants(m);
});

test("T12 repeated OTP handover events cannot release twice", { skip }, async () => {
  const m = await newMerchant();
  const order = await earn(m);
  // The rider's OTP step cannot be replayed: the order is delivered and its receipt is immutable.
  await assert.rejects(deliverWithRiderOtp(sql, { orderId: order.orderId, at: new Date() }));
  await assert.rejects(sql.query(`update orders set customer_received_at=now() where id=$1`, [order.orderId]), /immutable/);
  await sql.query(`select release_matured_wallet_funds(1000)`);
  const rel = await sql.query(`select count(*)::int n from wallet_ledger_entries where order_id=$1 and entry_type='release' and bucket='withheld'`, [order.orderId]);
  assert.equal(rel[0].n, 1);
});

test("T13 withdrawal during the 24-hour hold is rejected", { skip }, async () => {
  const m = await newMerchant();
  await earn(m, { deliveredHoursAgo: 2 });
  const b = await balances(m);
  assert.ok(b.withheld > 0 && b.available === 0);
  await assert.rejects(request(m, "10.00"), /exceeds available/);
});

test("T14 withdrawing exactly the available balance reserves all of it", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const { available } = await balances(m);
  const r = await request(m, available.toFixed(2));
  const b = await assertInvariants(m);
  assert.equal(b.available, 0);
  assert.equal(b.processing, available);
  assert.equal((await payout(r.payoutId)).amount, available.toFixed(2));
});

test("T15 withdrawal above the balance is rejected", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const { available } = await balances(m);
  await assert.rejects(request(m, (available + 0.01).toFixed(2)), /exceeds available/);
});

test("T16 partial withdrawal leaves an accurate remaining balance", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const { available } = await balances(m);
  const r = await request(m, "30.00");
  await sim.finish(r.payoutId, "paid"); await due(r.payoutId); await wallet.reconcilePayouts();
  const b = await assertInvariants(m);
  assert.equal(b.available, available - 30);
  assert.equal(b.paid_out, 29);
  assert.equal(b.payout_fees, 1);
});

test("T17 cross-merchant requests are rejected", { skip }, async () => {
  const a = await newMerchant(); await earn(a);
  const b = await newMerchant(); await earn(b);
  await assert.rejects(authz.requireMerchantAccessForUserId(b.merchant, a.user), /access denied/i);
  await assert.rejects(wallet.requestWithdrawal({ merchantId: b.merchant, userId: a.user, amount: "10.00", destinationId: a.destination, idempotencyKey: key() }), /not verified/);
  const pb = await reserve(b, "10.00");
  await assert.rejects(wallet.cancelWithdrawal({ merchantId: a.merchant, payoutId: pb, userId: a.user }), /not found/);
});

test("T18 a destination change in flight cannot redirect the payout", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const id = await reserve(m, "20.00");
  const authorized = (await payout(id)).destination_ref;
  await assert.rejects(sql.query(`update merchant_payout_accounts set destination_ref='attacker' where id=$1`, [m.destination]), /immutable/);
  await assert.rejects(sql.query(`update wallet_payouts set destination_ref='attacker' where id=$1`, [id]), /immutable/);
  await wallet.registerPayoutDestination({ merchantId: m.merchant, rail: "mobile_money", accountNumber: "+233209999999", institutionCode: "VOD", accountName: "Someone Else", actorUserId: m.user });
  await wallet.dispatchPayouts({ payoutId: id });
  assert.deepEqual((await sim.transfers(id)).map((t) => t.destination_ref), [authorized]);
});

test("T19 refunds racing withdrawals keep the ledger whole", { skip }, async () => {
  const m = await newMerchant();
  const orders = [];
  for (let i = 0; i < 4; i++) orders.push(await earn(m));
  const { available } = await balances(m);
  const refunds = orders.map(async (o, i) => {
    const [{ id, grand_total }] = await sql.query(`select p.id, o.grand_total from payments p join orders o on o.id=p.order_id where o.id=$1`, [o.orderId]);
    await sql.query(`insert into provider_refund_requests(id,payment_id,order_id,provider_key,provider_reference,amount,currency,status,processed_at)
                     values($1,$2,$3,'paystack',$4,$5,'GHS','processed',now())`, [`rf_t19_${i}_${o.orderId}`, id, o.orderId, `rr${i}`, grand_total]);
  });
  const withdrawals = [...Array(5)].map(() => request(m, available.toFixed(2)).catch((e) => e));
  await Promise.all([...refunds, ...withdrawals]);
  const b = await assertInvariants(m);
  assert.equal(b.refunded, b.total_sales, "every sale refunded");
  assert.ok(b.processing <= available);
  assert.equal(Math.round(b.recovery_due * 100), Math.round(b.processing * 100), "money reserved before the refunds is owed back, not lost");
});

test("T20 a duplicated queue job sends once", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const id = await reserve(m, "15.00");
  const startAt = Date.now() + 9000;
  await Promise.all([
    worker({ action: "dispatch", payoutId: id, startAt }),
    worker({ action: "settle", startAt }),
    ...[...Array(10)].map(() => new Promise((r) => setTimeout(r, Math.max(0, startAt - Date.now())))
      .then(() => wallet.dispatchPayouts({ payoutId: id }))),
  ]);
  assert.equal(await sends(id), 1);
  assert.equal((await sim.transfers(id)).length, 1);
});

test("T21 staff cannot retry or re-decide a settled payout", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const r = await request(m, "20.00");
  await sim.finish(r.payoutId, "paid"); await due(r.payoutId); await wallet.reconcilePayouts();
  assert.equal((await payout(r.payoutId)).status, "paid");
  const evidence = "Provider dashboard shows transfer completed on 10 Nov";
  await assert.rejects(wallet.resolvePayoutByAdmin({ payoutId: r.payoutId, outcome: "requeue", adminId: "adm", evidence }), /cannot be resolved or retried/);
  await assert.rejects(wallet.resolvePayoutByAdmin({ payoutId: r.payoutId, outcome: "failed", adminId: "adm", evidence }), /cannot be resolved or retried/);
  await assert.rejects(sql.query(`update wallet_payouts set status='requested' where id=$1`, [r.payoutId]), /final/);
  const again = await sql.query(`select wallet_settle_payout($1,'paid',null,null,null,'admin') as r`, [r.payoutId]);
  assert.equal(again[0].r.duplicate, true);
  assert.equal(await ledgerCount(r.payoutId, "payout_paid"), 2);
  // Quarantined payouts need written evidence.
  const q = await newMerchant("mockb"); await earn(q);
  await sim.injectFault("mockb", "create", "timeout_before");
  const rq = await request(q, "20.00"); await due(rq.payoutId); await wallet.dispatchPayouts({ payoutId: rq.payoutId });
  assert.equal((await payout(rq.payoutId)).status, "needs_attention");
  await assert.rejects(wallet.resolvePayoutByAdmin({ payoutId: rq.payoutId, outcome: "failed", adminId: "adm", evidence: "short" }), /evidence/);
  const resolved = await wallet.resolvePayoutByAdmin({ payoutId: rq.payoutId, outcome: "failed", adminId: "adm",
    evidence: "Provider support confirmed no transfer exists for this reference" });
  assert.equal(resolved.status, "failed");
  assert.equal((await balances(q)).available > 0, true, "reservation released once non-payment was established");
  selectDriver("mocka");
});

test("T22 database restart: durable recovery", { skip: skip || (!process.env.ELEMARKET_TEST_PG_RESTART_CMD && "set ELEMARKET_TEST_PG_RESTART_CMD to enable") }, async () => {
  const m = await newMerchant(); await earn(m);
  const id = await reserve(m, "22.00");
  await sim.injectFault("mocka", "create", "crash_after");
  assert.equal((await worker({ action: "dispatch", payoutId: id })).crashed, true);
  execSync(process.env.ELEMARKET_TEST_PG_RESTART_CMD, { stdio: "ignore" });
  // The pool reconnects; durable state survived the restart.
  let state;
  for (let i = 0; i < 20; i++) { try { state = await payout(id); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  assert.equal(state.status, "submitting");
  await due(id);
  const recovered = await worker({ action: "dispatch", payoutId: id });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal((await payout(id)).status, "processing");
  assert.equal((await sim.transfers(id)).length, 1);
});

test("T23 a confirmed provider failure releases the reservation once", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const before = await balances(m);
  const r = await request(m, "40.00");
  await sim.finish(r.payoutId, "failed");
  const raw = JSON.stringify({ payoutId: r.payoutId });
  await Promise.all([webhook(raw), webhook(raw), (async () => { await due(r.payoutId); await wallet.reconcilePayouts(); })()]);
  assert.equal((await payout(r.payoutId)).status, "failed");
  assert.equal(await ledgerCount(r.payoutId, "payout_returned"), 2, "one return pair");
  assert.deepEqual(await balances(m), before);
});

test("T24 a lost callback is resolved by reconciliation", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const r = await request(m, "18.00");
  await sim.finish(r.payoutId, "paid"); // provider finished; its notification never arrives
  await due(r.payoutId);
  const out = await wallet.reconcilePayouts();
  assert.equal(out[r.payoutId], "paid");
  await assertInvariants(m);
});

test("T25 a forged callback is rejected and changes nothing", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const r = await request(m, "18.00");
  const raw = JSON.stringify({ payoutId: r.payoutId, providerReference: "x", status: "failed" });
  await assert.rejects(wallet.handlePayoutWebhook({ rawBody: raw, headers: new Headers({ "x-sim-signature": "0".repeat(64) }) }), (e) => e.status === 401);
  assert.equal((await payout(r.payoutId)).status, "processing");
  assert.equal((await sql.query(`select count(*)::int n from wallet_payout_events where payout_id=$1`, [r.payoutId]))[0].n, 0);
});

test("T26 a replayed request after a restart is not duplicated", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const k = key();
  const first = await request(m, "12.00", k);
  const replay = await worker({ action: "request", input: { merchantId: m.merchant, userId: m.user, amount: "12.00", destinationId: m.destination, idempotencyKey: k } });
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.result.payoutId, first.payoutId);
  assert.equal(replay.result.replay, true);
  assert.equal((await sim.transfers(first.payoutId)).length, 1);
});

test("T27 an externally duplicated payout is detected and flagged", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  await sim.injectFault("mocka", "create", "duplicate");
  const r = await request(m, "16.00");
  assert.equal((await sim.transfers(r.payoutId)).length, 2, "SIMULATED: provider sent twice");
  await wallet.reconcileProviderRecords(24);
  assert.ok((await exceptions(r.payoutId)).includes("duplicate_external_payout"));
  const [{ severity }] = await sql.query(`select severity from wallet_reconciliation_exceptions where payout_id=$1 and kind='duplicate_external_payout'`, [r.payoutId]);
  assert.equal(severity, "critical");
});

test("T28 the same key with a changed amount is an idempotency conflict", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  const k = key();
  await request(m, "10.00", k);
  await assert.rejects(request(m, "11.00", k), /idempotency conflict/);
  await assert.rejects(sql.query(`select wallet_request_payout($1,11,1,$2,'mocka',$3,$4,'{}'::jsonb)`, [m.merchant, m.destination, k, m.user]), /idempotency conflict/);
});

test("T29 concurrent holds, releases, refunds and withdrawals stay consistent", { skip }, async () => {
  const merchants = [];
  for (let i = 0; i < 3; i++) { const m = await newMerchant(); await earn(m); await earn(m, { deliveredHoursAgo: 1, release: false }); merchants.push(m); }
  const work = [];
  for (const m of merchants) {
    work.push(...[...Array(3)].map(() => request(m, "50.00").catch(() => null)));
    work.push(sql.query(`select release_matured_wallet_funds(1000)`));
    work.push(earn(m, { deliveredHoursAgo: MATURED }));
  }
  work.push(...[...Array(4)].map(() => wallet.runWalletSettlement()));
  await Promise.all(work);
  for (const m of merchants) await assertInvariants(m);
  const [{ s }] = await sql.query(`select wallet_reconciliation_summary() as s`);
  assert.equal(Number(s.invariantViolations), 0);
});

test("T30 the same guarantees hold for every provider adapter, with no core changes", { skip }, async () => {
  const results = {};
  for (const drv of ["mocka", "mockb", "mockc"]) {
    const m = await newMerchant(drv); await earn(m);
    const r = await request(m, "20.00");
    const ref = (await sim.transfers(r.payoutId))[0].reference;
    await sim.finish(r.payoutId, "paid");
    if (drv === "mockc") await webhook(JSON.stringify({ payoutId: r.payoutId, providerReference: ref, status: "paid" }));
    else { await due(r.payoutId); await wallet.reconcilePayouts(); }
    assert.equal((await payout(r.payoutId)).status, "paid", drv);
    // Uncertainty is handled per declared capability, never by a blind resend.
    await sim.injectFault(drv, "create", "timeout_before");
    const u = await request(m, "20.00");
    await due(u.payoutId); await wallet.dispatchPayouts({ payoutId: u.payoutId });
    const after = await payout(u.payoutId);
    results[drv] = after.status;
    assert.ok((await sim.transfers(u.payoutId)).length <= 1, `${drv}: at most one transfer`);
    await assertInvariants(m);
  }
  assert.deepEqual(results, { mocka: "processing", mockb: "needs_attention", mockc: "needs_attention" });
  selectDriver("mocka");
});

test("Extra: new payout destinations wait out a security cooling period; limits apply", { skip }, async () => {
  const m = await newMerchant(); await earn(m);
  process.env.ELEMARKET_WALLET_DESTINATION_COOLDOWN_HOURS = "24";
  try {
    await assert.rejects(request(m, "10.00"), /cooling period/);
  } finally { process.env.ELEMARKET_WALLET_DESTINATION_COOLDOWN_HOURS = "0"; }
  process.env.ELEMARKET_WALLET_MAX_WITHDRAWAL = "15";
  try { await assert.rejects(request(m, "20.00"), /above the maximum/); } finally { delete process.env.ELEMARKET_WALLET_MAX_WITHDRAWAL; }
  await assert.rejects(request(m, "0.50"), /larger than the transfer fee/);
  process.env.ELEMARKET_WALLET_MIN_WITHDRAWAL = "5";
  try { await assert.rejects(request(m, "2.00"), /below the minimum/); } finally { process.env.ELEMARKET_WALLET_MIN_WITHDRAWAL = "1"; }
  const daily = process.env.ELEMARKET_WALLET_DAILY_WITHDRAWAL_COUNT;
  process.env.ELEMARKET_WALLET_DAILY_WITHDRAWAL_COUNT = "1";
  try {
    const first = await request(m, "5.00");
    await sim.finish(first.payoutId, "paid"); await due(first.payoutId); await wallet.reconcilePayouts();
    await assert.rejects(request(m, "5.00"), /daily withdrawal count/);
  } finally { process.env.ELEMARKET_WALLET_DAILY_WITHDRAWAL_COUNT = daily; }
});
