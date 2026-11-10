// Merchant wallet lifecycle through the real server code and database:
// sale -> withheld -> released -> withdrawal -> paid / returned, plus refunds.
// Payment provider mocked in-process; payouts use the development sandbox driver.
// Run: npm run test:wallet:simulation
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  checkout,
  configureSimulationEnv,
  installPaymentProviderMock,
  seedOrder,
  startHarness,
} from "../scripts/helpers/server-harness.mjs";

configureSimulationEnv({
  ELEMARKET_PAYOUT_DRIVER: "sandbox",
  ELEMARKET_ENABLE_PAYOUT_SANDBOX: "1",
  ELEMARKET_PAYOUT_FEE_FLAT: "1.00",
  ELEMARKET_PAYOUT_FEE_BPS: "0",
});
const provider = installPaymentProviderMock();
// Fresh request id per withdrawal attempt (what the UI generates per form).
const requestId = () => crypto.randomUUID();
let harness, sql, pay, wallet, payments, handlePaymentWebhook;
let seed, merchantNet;

before(async () => {
  harness = await startHarness();
  sql = harness.sql;
  payments = await harness.load("/src/modules/payments/public/payment.server.ts");
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));
  wallet = await harness.load("/src/modules/wallet/public/wallet.server.ts");
  let eventId = 50_000;
  pay = async (order, userId) => {
    const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId });
    const pesewas = Math.round(Number(order.grandTotal) * 100);
    provider.pay(intent.providerReference);
    const raw = JSON.stringify({ event: "charge.success", data: { id: eventId++, reference: intent.providerReference, amount: pesewas, currency: "GHS" } });
    await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
    return intent;
  };
  seed = await seedOrder(sql);
  await sql.query(`update product_variants set stock=50 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=50, return_window_days=2 where id=$1`, [seed.product]);
});
after(async () => {
  provider.restore();
  await harness?.close();
});

const balances = async () => {
  const [b] = await sql.query(
    `select total_sales::text, refunded::text, withheld::text, available::text, processing::text, paid_out::text, payout_fees::text
       from merchant_wallet_balances where merchant_id=$1`, [seed.merchant]);
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Number(v)]));
};
const assertLedgerBalanced = async () => {
  const b = await balances();
  const held = b.withheld + b.available + b.processing + b.paid_out + b.payout_fees;
  assert.equal(Math.round(held * 100), Math.round((b.total_sales - b.refunded) * 100), "every cedi is in exactly one bucket");
};
/**
 * Fixture: the order was delivered with a rider OTP handover `daysAgo` days ago.
 * The real handover chain (delivery job, rider OTP, evidence) is exercised by the
 * delivery suites; here only its outcome matters, so triggers are suspended for
 * this single fixture statement. Wallet triggers live on payments and refunds.
 */
const deliver = async (orderId, daysAgo) => {
  await sql.query(`set session_replication_role = replica`);
  try {
    await sql.query(
      `update orders set status='delivered', customer_received_at=now()-make_interval(days=>$2),
              delivery_confirmation_source='delivery_otp' where id=$1`, [orderId, daysAgo]);
  } finally {
    await sql.query(`set session_replication_role = default`);
  }
};
const earn = async () => {
  const order = await checkout(sql, seed);
  await pay(order, seed.user);
  return order;
};

test("moving a merchant to the wallet waits for unpaid checkouts", async () => {
  // A charge started under the old split: the provider will pay the merchant directly.
  seed.splitIntent = await payments.createExternalPaymentIntent({ paymentId: seed.payment, userId: seed.user });
  assert.ok(provider.initializeBodies.at(-1).subaccount, "provider-direct charge is split to the merchant");
  await assert.rejects(wallet.enableWalletForMerchant(seed.merchant, "admin_sim"), /unpaid checkouts/);
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
  const result = await wallet.enableWalletForMerchant(seed.merchant, "admin_sim");
  assert.equal(result.settlementModel, "platform_wallet");
});

test("a split charge that completes late is never credited to the wallet (no double payment)", async () => {
  provider.pay(seed.splitIntent.providerReference);
  const raw = JSON.stringify({ event: "charge.success", data: { id: 49_999, reference: seed.splitIntent.providerReference, amount: 11500, currency: "GHS" } });
  await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) }).catch(() => undefined);
  const [{ stamp }] = await sql.query(`select settlement_model as stamp from payments where id=$1`, [seed.payment]);
  assert.equal(stamp, "provider_split");
  const [row] = await sql.query(`select count(*)::int as n from wallet_ledger_entries where order_id=$1`, [seed.order]);
  assert.equal(row.n, 0);
  await assert.rejects(
    sql.query(`update payments set settlement_model='platform_wallet' where id=$1`, [seed.payment]),
    /fixed once/,
  );
});

test("a wallet merchant's sale is charged without a split and credited as withheld", async () => {
  const before = provider.initializeBodies.length;
  const order = await earn();
  const init = provider.initializeBodies.at(before);
  assert.equal(init.subaccount, undefined, "no split to the merchant: the wallet pays out");
  [{ merchant_net: merchantNet }] = await sql.query(`select merchant_net::numeric as merchant_net from orders where id=$1`, [order.orderId]);
  merchantNet = Number(merchantNet);
  assert.ok(merchantNet > 0 && merchantNet <= 100, "merchant share excludes delivery and commission");
  const b = await balances();
  assert.equal(b.withheld, merchantNet);
  assert.equal(b.available, 0);
  await assertLedgerBalanced();
  seed.firstOrder = order.orderId;
});

test("withheld funds cannot be withdrawn, and do not release before the return window", async () => {
  const dest = await wallet.registerPayoutDestination({ merchantId: seed.merchant, rail: "mobile_money", accountNumber: "+233241112222", institutionCode: "MTN", accountName: "Sim Merchant" });
  assert.equal(dest.status, "verified");
  seed.destination = dest.destinationId;
  await assert.rejects(
    wallet.requestWithdrawal({ merchantId: seed.merchant, userId: seed.user, amount: "10.00", destinationId: dest.destinationId, idempotencyKey: requestId() }),
    /exceeds available/,
  );
  await deliver(seed.firstOrder, 1); // 1 day ago, window is 2 days
  await wallet.runWalletSettlement();
  assert.equal((await balances()).available, 0);
});

test("after delivery and the return window, funds become available", async () => {
  await deliver(seed.firstOrder, 3);
  const run = await wallet.runWalletSettlement();
  assert.equal(run.released, 1);
  const b = await balances();
  assert.equal(b.withheld, 0);
  assert.equal(b.available, merchantNet);
  assert.equal((await wallet.runWalletSettlement()).released, 0, "release is one-time");
  await assertLedgerBalanced();
});

test("an open dispute keeps funds withheld", async () => {
  const order = await earn();
  await deliver(order.orderId, 5);
  await sql.query(
    `insert into customer_order_disputes(id, order_id, payment_id, customer_id, reason, status)
     values($1,$2,$3,$4,'Item damaged on arrival','open')`,
    [`dsp_${order.orderId}`, order.orderId, order.paymentId, seed.user],
  );
  await wallet.runWalletSettlement();
  const b = await balances();
  assert.equal(b.withheld, merchantNet, "disputed order stays withheld");
  assert.equal(b.available, merchantNet, "only the first order is available");
  seed.disputedOrder = order.orderId;
});

test("withdrawal: fee paid by merchant, one command, read back as paid", async () => {
  const amount = merchantNet.toFixed(2);
  const quote = await wallet.quoteWithdrawal({ merchantId: seed.merchant, amount, destinationId: seed.destination });
  assert.equal(quote.fee, "1.00");
  assert.equal(Number(quote.netAmount), merchantNet - 1);

  const key = requestId();
  const first = await wallet.requestWithdrawal({ merchantId: seed.merchant, userId: seed.user, amount, destinationId: seed.destination, idempotencyKey: key });
  assert.equal(first.status, "processing", "command sent to the payout provider");
  const replay = await wallet.requestWithdrawal({ merchantId: seed.merchant, userId: seed.user, amount, destinationId: seed.destination, idempotencyKey: key });
  assert.equal(replay.payoutId, first.payoutId, "double-click does not create a second payout");
  await assert.rejects(
    wallet.requestWithdrawal({ merchantId: seed.merchant, userId: seed.user, amount: "1.50", destinationId: seed.destination, idempotencyKey: requestId() }),
    /exceeds available|already in progress/,
  );
  let b = await balances();
  assert.equal(b.available, 0);
  assert.equal(b.processing, merchantNet);

  await sql.query(`update wallet_payouts set updated_at=now()-interval '5 minutes' where id=$1`, [first.payoutId]);
  const run = await wallet.runWalletSettlement();
  assert.equal(run.reconciled[first.payoutId], "paid");
  b = await balances();
  assert.equal(b.processing, 0);
  assert.equal(b.paid_out, merchantNet - 1);
  assert.equal(b.payout_fees, 1);
  await assertLedgerBalanced();
});

test("a failed payout returns the money to available", async () => {
  await sql.query(`update customer_order_disputes set status='closed' where order_id=$1`, [seed.disputedOrder]);
  await wallet.runWalletSettlement();
  assert.equal((await balances()).available, merchantNet);
  const bad = await wallet.registerPayoutDestination({ merchantId: seed.merchant, rail: "mobile_money", accountNumber: "+233240000000", institutionCode: "MTN", accountName: "Sim Merchant" });
  const payout = await wallet.requestWithdrawal({ merchantId: seed.merchant, userId: seed.user, amount: "20.00", destinationId: bad.destinationId, idempotencyKey: requestId() });
  await sql.query(`update wallet_payouts set updated_at=now()-interval '5 minutes' where id=$1`, [payout.payoutId]);
  const run = await wallet.runWalletSettlement();
  assert.equal(run.reconciled[payout.payoutId], "failed");
  const b = await balances();
  assert.equal(b.available, merchantNet, "nothing lost");
  assert.equal(b.processing, 0);
  await assertLedgerBalanced();
});

test("refunds reduce withheld first, then available", async () => {
  const order = await earn();
  const [{ id: paymentId, grand_total }] = await sql.query(
    `select p.id, o.grand_total::numeric as grand_total from payments p join orders o on o.id=p.order_id where o.id=$1`, [order.orderId]);
  const before = await balances();
  // Provider confirms a full refund of this order (product + delivery).
  await sql.query(
    `insert into provider_refund_requests(id,payment_id,order_id,provider_key,provider_reference,amount,currency,status,processed_at)
     values($1,$2,$3,'paystack',$4,$5,'GHS','processed',now())`,
    [`rf_${order.orderId}`, paymentId, order.orderId, `ref_${order.orderId}`, grand_total],
  );
  const after = await balances();
  assert.equal(after.withheld, before.withheld - merchantNet, "merchant share removed from withheld");
  assert.equal(after.available, before.available);
  assert.equal(after.refunded, before.refunded + merchantNet);
  await assertLedgerBalanced();
});

test("the ledger is append-only", async () => {
  await assert.rejects(sql.query(`update wallet_ledger_entries set amount=amount*2 where merchant_id=$1`, [seed.merchant]), /append-only/);
  await assert.rejects(sql.query(`delete from wallet_ledger_entries where merchant_id=$1`, [seed.merchant]), /append-only/);
});

test("provider-direct merchants are never credited (no double payment)", async () => {
  const other = await seedOrder(sql);
  await pay({ paymentId: other.payment, grandTotal: "115.00" }, other.user);
  const [row] = await sql.query(`select count(*)::int as n from wallet_ledger_entries where merchant_id=$1`, [other.merchant]);
  assert.equal(row.n, 0);
});
