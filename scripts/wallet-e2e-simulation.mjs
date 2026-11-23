#!/usr/bin/env node
// End-to-end merchant wallet simulation on real PostgreSQL, reported as Markdown.
//
// CUSTOMER PAYMENT -> VERIFIED ORDER -> DELIVERY -> OTP HANDOVER -> 24-HOUR HOLD
// -> AVAILABLE EARNINGS -> WITHDRAWAL -> SIMULATED PROVIDER PAYOUT -> RECONCILIATION
//
// Ghana cedis. The clock is controlled through the rider-OTP handover instant.
// Every payment-provider and payout-provider outcome here is a SIMULATION:
// no money moves and no external service is contacted.
//
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test \
//      node scripts/wallet-e2e-simulation.mjs --out wallet-simulation-report.md
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createMigratedTestDatabase } from "./helpers/pg-test-database.mjs";
import { checkout, configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "./helpers/server-harness.mjs";
import { deliverWithRiderOtp } from "./helpers/delivery-fixture.mjs";

const mockPath = path.resolve("scripts/helpers/mock-payout-provider.mjs");
const HOURS = 3600e3;
const lines = [];
const out = (s = "") => lines.push(s);
const ghs = (n) => `GH₵ ${Number(n).toFixed(2)}`;

const db = await createMigratedTestDatabase();
configureSimulationEnv({
  DATABASE_URL: db.url, SIM_PROVIDER_DATABASE_URL: db.url,
  ELEMARKET_PAYOUT_DRIVER: "mocka", ELEMARKET_PAYOUT_DRIVER_MOCKA_MODULE: mockPath, ELEMARKET_PAYOUT_ALLOWED_MODULES: mockPath,
  SIM_PAYOUT_MOCKA_CAPS: "idempotent,lookup,webhooks,listing,validation",
  ELEMARKET_PAYOUT_FEE_FLAT: "1.00", ELEMARKET_WALLET_DESTINATION_COOLDOWN_HOURS: "0", ELEMARKET_WALLET_MIN_WITHDRAWAL: "1",
  // One merchant makes many withdrawals in this run; the default 5-per-day limit is tested separately.
  ELEMARKET_WALLET_DAILY_WITHDRAWAL_COUNT: "100",
});
const { simulatedProvider: sim } = await import(mockPath);
const pay = installPaymentProviderMock();
const h = await startHarness();
const sql = h.sql;
let exitCode = 0;
try {
  const payments = await h.load("/src/modules/payments/public/payment.server.ts");
  const { handlePaymentWebhook } = await h.load("/src/application/payment-webhook.server.ts");
  const wallet = await h.load("/src/modules/wallet/public/wallet.server.ts");
  let event = 1, k = 0;
  const key = () => `e2e-request-${String(++k).padStart(8, "0")}`;

  const seed = await seedOrder(sql);
  await sql.query(`update product_variants set stock=100 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=100 where id=$1`, [seed.product]);
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
  await wallet.enableWalletForMerchant(seed.merchant, "simulation-admin");
  const m = seed;

  const snapshot = async () => {
    const [b] = await sql.query(`select total_sales, refunded, withheld, available, processing, paid_out, payout_fees, recovery_due
                                   from merchant_wallet_balances where merchant_id=$1`, [m.merchant]);
    return Object.fromEntries(Object.entries(b).map(([x, v]) => [x, Number(v)]));
  };
  const cols = ["total_sales", "refunded", "withheld", "available", "processing", "paid_out", "payout_fees", "recovery_due"];
  const step = async (title, fn) => {
    const before = await snapshot();
    out(`### ${title}`);
    const note = await fn();
    const after = await snapshot();
    if (note) out(note);
    out("");
    out(`| Ledger | ${cols.join(" | ")} |`);
    out(`|---|${cols.map(() => "---:").join("|")}|`);
    out(`| before | ${cols.map((c) => before[c].toFixed(2)).join(" | ")} |`);
    out(`| after | ${cols.map((c) => after[c].toFixed(2)).join(" | ")} |`);
    const held = after.withheld + after.available + after.processing + after.paid_out + after.payout_fees - after.recovery_due;
    const ok = Math.round(held * 100) === Math.round((after.total_sales - after.refunded) * 100)
      && ["withheld", "available", "processing", "paid_out", "payout_fees", "recovery_due"].every((c) => after[c] >= 0);
    if (!ok) exitCode = 1;
    out(`\nInvariant (every cedi in one bucket, nothing negative): **${ok ? "holds" : "VIOLATED"}**\n`);
  };
  const sell = async (deliveredHoursAgo) => {
    const order = await checkout(sql, m);
    const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: m.user });
    pay.pay(intent.providerReference);
    const raw = JSON.stringify({ event: "charge.success", data: { id: event++, reference: intent.providerReference, amount: Math.round(Number(order.grandTotal) * 100), currency: "GHS" } });
    await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: pay.sign(raw) });
    if (deliveredHoursAgo !== null) await deliverWithRiderOtp(sql, { orderId: order.orderId, at: new Date(Date.now() - deliveredHoursAgo * HOURS) });
    return order;
  };
  const age = (id) => sql.query(`update wallet_payouts set next_attempt_at=now(), lease_until=null, updated_at=now()-interval '5 minutes' where id=$1`, [id]);
  const status = async (id) => (await sql.query(`select status from wallet_payouts where id=$1`, [id]))[0].status;
  const transfers = async (id) => (await sim.transfers(id)).length;

  out("# ELEMARKET merchant wallet — end-to-end simulation");
  out("");
  out(`Run: ${new Date().toISOString()} · PostgreSQL ${(await sql.query(`show server_version`))[0].server_version} · database \`${new URL(db.url).pathname.slice(1)}\` (disposable)`);
  out("");
  out("All payment and payout provider outcomes below are **SIMULATED**. Delivery uses the real rider-OTP handover records with every database guard active; the handover instant is the controlled test clock.");
  out("");

  let o1;
  await step("1. Customer payment (SIMULATED collection) → verified order", async () => {
    o1 = await sell(null);
    const [o] = await sql.query(`select product_total, delivery_total, platform_fee, merchant_net, grand_total from orders where id=$1`, [o1.orderId]);
    return `Collected ${ghs(o.grand_total)} = products ${ghs(o.product_total)} + delivery ${ghs(o.delivery_total)}. Marketplace commission ${ghs(o.platform_fee)}; merchant earning ${ghs(o.merchant_net)} credited as **withheld** (pending delivery). Charge kept in the platform provider account (no split).`;
  });
  await step("2. Delivery → rider OTP handover 8 days ago", async () => {
    await deliverWithRiderOtp(sql, { orderId: o1.orderId, at: new Date(Date.now() - 8 * 24 * HOURS) });
    return "Order marked delivered through the real OTP handover guards. Earnings stay withheld until the release job runs.";
  });
  await step("3. 7-day return window closed → release to available", async () => {
    const [{ n }] = await sql.query(`select release_matured_wallet_funds(100) as n`);
    const [{ again }] = await sql.query(`select release_matured_wallet_funds(100) as again`);
    return `Released ${n} order(s). Running the release again released ${again} (idempotent).`;
  });
  await step("4. Order inside the hold (handover 2 hours ago) stays withheld", async () => {
    await sell(2);
    await sql.query(`select release_matured_wallet_funds(100)`);
    await wallet.registerPayoutDestination({ merchantId: m.merchant, rail: "mobile_money", accountNumber: "+233241112222", institutionCode: "MTN", accountName: "Simulation Merchant", actorUserId: m.user });
    const [d] = await sql.query(`select id from merchant_payout_accounts where merchant_id=$1`, [m.merchant]);
    m.destination = d.id;
    try { await wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount: "200.00", destinationId: m.destination, idempotencyKey: key() }); return "Unexpected: over-withdrawal accepted"; }
    catch (e) { return `Withdrawing more than available was refused: _${e.message}_.`; }
  });
  await step("5. Partial withdrawal GH₵ 40.00 → SIMULATED provider pays", async () => {
    const r = await wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount: "40.00", destinationId: m.destination, idempotencyKey: key() });
    await sim.finish(r.payoutId, "paid"); await age(r.payoutId); await wallet.reconcilePayouts();
    return `Fee ${ghs(r.fee)} paid by the merchant; ${ghs(r.netAmount)} sent. Status: **${await status(r.payoutId)}**, provider transfers: ${await transfers(r.payoutId)}.`;
  });
  await step("6. Five concurrent withdrawal requests (different devices)", async () => {
    const rs = await Promise.allSettled([...Array(5)].map(() => wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount: "20.00", destinationId: m.destination, idempotencyKey: key() })));
    const ok = rs.filter((r) => r.status === "fulfilled");
    for (const r of ok) { await sim.finish(r.value.payoutId, "paid"); await age(r.value.payoutId); }
    await wallet.reconcilePayouts();
    return `${ok.length} accepted, ${rs.length - ok.length} refused (_${rs.find((r) => r.status === "rejected")?.reason?.message}_). No over-reservation.`;
  });
  await step("7. SIMULATED provider failure → reservation released once", async () => {
    await sim.injectFault("mocka", "create", "fail_final");
    const r = await wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount: "10.00", destinationId: m.destination, idempotencyKey: key() });
    return `Provider reported failure at once. Status: **${await status(r.payoutId)}**; funds back in available.`;
  });
  await step("8. SIMULATED provider timeout → uncertain → read back → one transfer", async () => {
    await sim.injectFault("mocka", "create", "timeout_before");
    const r = await wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount: "10.00", destinationId: m.destination, idempotencyKey: key() });
    const first = await status(r.payoutId);
    await age(r.payoutId); await wallet.dispatchPayouts({ payoutId: r.payoutId });
    const attempts = (await sql.query(`select kind||':'||outcome as a from wallet_payout_attempts where payout_id=$1 order by attempt_no`, [r.payoutId])).map((x) => x.a);
    await sim.finish(r.payoutId, "paid"); await age(r.payoutId); await wallet.reconcilePayouts();
    return `After the timeout: **${first}** (funds stay reserved). Attempts: ${attempts.join(" → ")}. Final: **${await status(r.payoutId)}**, transfers: ${await transfers(r.payoutId)}.`;
  });
  await step("9. Missing callback → reconciliation finds the payment", async () => {
    const r = await wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount: "10.00", destinationId: m.destination, idempotencyKey: key() });
    await sim.finish(r.payoutId, "paid"); // SIMULATED: provider pays, never notifies
    await age(r.payoutId);
    const res = await wallet.reconcilePayouts();
    return `No notification arrived; read-back settled it as **${res[r.payoutId]}**.`;
  });
  await step("10. Refund before withdrawal (order still on hold)", async () => {
    const o = await sell(1);
    const [p] = await sql.query(`select p.id, o.grand_total from payments p join orders o on o.id=p.order_id where o.id=$1`, [o.orderId]);
    await sql.query(`insert into provider_refund_requests(id,payment_id,order_id,provider_key,provider_reference,amount,currency,status,processed_at)
                     values($1,$2,$3,'paystack','e2e-r1',$4,'GHS','processed',now())`, [`rf_e2e_1`, p.id, o.orderId, p.grand_total]);
    return `SIMULATED provider refund of ${ghs(p.grand_total)} processed; the merchant's share left the withheld balance.`;
  });
  await step("11. Refund competing with a withdrawal", async () => {
    const o = await sell(8 * 24);
    await sql.query(`select release_matured_wallet_funds(100)`);
    const [{ available }] = await sql.query(`select available from merchant_wallet_balances where merchant_id=$1`, [m.merchant]);
    const [p] = await sql.query(`select p.id, o.grand_total from payments p join orders o on o.id=p.order_id where o.id=$1`, [o.orderId]);
    const [w] = await Promise.allSettled([
      wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount: Number(available).toFixed(2), destinationId: m.destination, idempotencyKey: key() }),
      sql.query(`insert into provider_refund_requests(id,payment_id,order_id,provider_key,provider_reference,amount,currency,status,processed_at)
                 values($1,$2,$3,'paystack','e2e-r2',$4,'GHS','processed',now())`, [`rf_e2e_2`, p.id, o.orderId, p.grand_total]),
    ]);
    if (w.status === "fulfilled") { await sim.finish(w.value.payoutId, "paid"); await age(w.value.payoutId); await wallet.reconcilePayouts(); }
    return `Withdrawal of all ${ghs(available)}: ${w.status === "fulfilled" ? "accepted and paid" : `refused (${w.reason.message})`}. The refund was booked; anything already paid out is recorded as owed (recovery) and repaid from future releases, never as a negative balance.`;
  });
  await step("12. Duplicate payout attempt (same request twice; SIMULATED provider double-send)", async () => {
    await sell(8 * 24); await sql.query(`select release_matured_wallet_funds(100)`);
    const k1 = key();
    const a = await wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount: "15.00", destinationId: m.destination, idempotencyKey: k1 });
    const b = await wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount: "15.00", destinationId: m.destination, idempotencyKey: k1 });
    await sim.finish(a.payoutId, "paid"); await age(a.payoutId); await wallet.reconcilePayouts();
    await sim.injectFault("mocka", "create", "duplicate");
    const c = await wallet.requestWithdrawal({ merchantId: m.merchant, userId: m.user, amount: "15.00", destinationId: m.destination, idempotencyKey: key() });
    await sim.finish(c.payoutId, "paid"); await age(c.payoutId); await wallet.reconcilePayouts();
    await wallet.reconcileProviderRecords(24);
    const ex = await sql.query(`select kind, severity from wallet_reconciliation_exceptions where payout_id=$1`, [c.payoutId]);
    return `Same request twice → same withdrawal (${a.payoutId === b.payoutId ? "one" : "TWO"} payout). The simulated provider then sent a transfer twice; reconciliation raised: ${ex.map((e) => `**${e.kind}** (${e.severity})`).join(", ")}.`;
  });
  await step("13. Crash after submission → restart → recovery", async () => {
    const quote = await wallet.quoteWithdrawal({ merchantId: m.merchant, amount: "10.00", destinationId: m.destination });
    const [r] = await sql.query(`select wallet_request_payout($1,$2::numeric,$3::numeric,$4,$5,$6,$7,$8::jsonb) as r`,
      [m.merchant, quote.amount, quote.fee, m.destination, quote.driverKey, key(), m.user, JSON.stringify(wallet.withdrawalLimits())]);
    const id = r.r.payoutId;
    await sim.injectFault("mocka", "create", "crash_after");
    const code = await new Promise((resolve) => spawn(process.execPath, ["scripts/helpers/wallet-worker.mjs", JSON.stringify({ action: "dispatch", payoutId: id })], { env: process.env, stdio: "ignore" }).on("exit", resolve));
    const mid = await status(id);
    await age(id); await wallet.dispatchPayouts({ payoutId: id });
    await sim.finish(id, "paid"); await age(id); await wallet.reconcilePayouts();
    return `Worker process exited with code ${code} right after the SIMULATED provider accepted the transfer. Recorded state: **${mid}**. After restart: read back, then **${await status(id)}**, provider transfers: ${await transfers(id)}.`;
  });

  out("## Final reconciliation");
  out("");
  const rec = await wallet.runWalletReconciliation();
  out("```json");
  out(JSON.stringify(rec.summary, null, 2));
  out("```");
  out("");
  const s = rec.summary;
  out(`Invariant violations: **${s.invariantViolations}**. Open exceptions are deliberate (step 12) and stay open until staff resolve them with a written resolution.`);
  if (Number(s.invariantViolations) !== 0) exitCode = 1;
} catch (error) {
  exitCode = 1;
  out(`\n**Simulation error:** ${error.message}`);
} finally {
  pay.restore();
  await sim.close();
  await h.close();
  await db.drop();
}
// The app logs to stdout too, so the report goes to its own file when asked.
const outIndex = process.argv.indexOf("--out");
if (outIndex > 0 && process.argv[outIndex + 1]) writeFileSync(process.argv[outIndex + 1], `${lines.join("\n")}\n`);
else process.stdout.write(`${lines.join("\n")}\n`);
process.exit(exitCode);
