// Money audit M5: a refund whose outcome was unknown (timeout, crash, or a
// refund.failed webhook) used to be stuck forever. The Paystack adapter now
// looks the refund up and never creates one while doing so.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadTypeScript } from "../scripts/helpers/load-typescript.mjs";
import { marketplaceSettlementChargePesewas } from "../src/lib/commerce-guards.mjs";

const { PaystackPaymentAdapter, mapPaystackRefundStatus } = loadTypeScript("src/modules/payments/internal/adapters/providers/paystack.ts", {
  "@/lib/security/body.server": { readResponseBodyWithLimit: (response) => response.text() },
  "@/lib/commerce-guards.mjs": { marketplaceSettlementChargePesewas },
  "@/modules/payments/internal/payment-errors": { PaymentProviderError: class PaymentProviderError extends Error {} },
});

async function withPaystack(routes, fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace("https://api.paystack.test", "");
    calls.push({ path, method: init.method ?? "GET" });
    const handler = Object.entries(routes).find(([prefix]) => path.startsWith(prefix))?.[1];
    if (!handler) return new Response("not found", { status: 404 });
    return Response.json(handler);
  };
  try { return await fn(new PaystackPaymentAdapter("secret", "https://api.paystack.test"), calls); }
  finally { globalThis.fetch = original; }
}
const req = (extra = {}) => ({ providerReference: "pay_ref_1", providerRefundId: null, amount: "115.00", currency: "GHS", idempotencyKey: "refund:prr_1", ...extra });

test("status mapping: failed and reversed refunds count as no refund (no money left)", () => {
  assert.equal(mapPaystackRefundStatus("processed"), "processed");
  assert.equal(mapPaystackRefundStatus("pending"), "processing");
  assert.equal(mapPaystackRefundStatus("processing"), "processing");
  assert.equal(mapPaystackRefundStatus("failed"), "absent");
  assert.equal(mapPaystackRefundStatus("reversed"), "absent");
  assert.equal(mapPaystackRefundStatus("needs-attention"), "needs_attention");
  assert.equal(mapPaystackRefundStatus("something_new"), "needs_attention");
});

test("with a refund id: fetches that refund and reports its real state", async () => {
  await withPaystack({ "/refund/777": { status: true, data: { id: 777, status: "processed", amount: 11500 } } }, async (a, calls) => {
    const r = await a.reconcileRefund(req({ providerRefundId: "777" }));
    assert.deepEqual([r.status, r.providerRefundId], ["processed", "777"]);
    assert.ok(calls.every((c) => c.method === "GET"), "never creates a refund");
  });
});

test("without an id: lists the transaction's refunds; none means not_found", async () => {
  await withPaystack({ "/transaction/verify/": { status: true, data: { id: 5001, status: "success", reference: "pay_ref_1", amount: 11500, currency: "GHS" } },
    "/refund?transaction=5001": { status: true, data: [] } }, async (a, calls) => {
    assert.deepEqual(await a.reconcileRefund(req()), { status: "not_found" });
    assert.deepEqual(calls.map((c) => c.path), ["/transaction/verify/pay_ref_1", "/refund?transaction=5001&perPage=100"]);
  });
});

test("only failed refunds on the transaction: not_found, so a new refund may be sent", async () => {
  await withPaystack({ "/transaction/verify/": { status: true, data: { id: 5001, status: "success", reference: "pay_ref_1", amount: 11500, currency: "GHS" } },
    "/refund?transaction=5001": { status: true, data: [{ id: 1, status: "failed", amount: 11500 }] } }, async (a) => {
    assert.deepEqual(await a.reconcileRefund(req()), { status: "not_found" });
  });
});

test("an existing pending refund is adopted, not duplicated", async () => {
  await withPaystack({ "/transaction/verify/": { status: true, data: { id: 5001, status: "success", reference: "pay_ref_1", amount: 11500, currency: "GHS" } },
    "/refund?transaction=5001": { status: true, data: [{ id: 1, status: "failed", amount: 11500 }, { id: 2, status: "pending", amount: 11500 }] } }, async (a) => {
    const r = await a.reconcileRefund(req());
    assert.deepEqual([r.status, r.providerRefundId], ["processing", "2"]);
  });
});

test("two live refunds for one payment are never auto-resolved", async () => {
  await withPaystack({ "/transaction/verify/": { status: true, data: { id: 5001, status: "success", reference: "pay_ref_1", amount: 11500, currency: "GHS" } },
    "/refund?transaction=5001": { status: true, data: [{ id: 1, status: "processed", amount: 11500 }, { id: 2, status: "pending", amount: 11500 }] } }, async (a) => {
    assert.equal((await a.reconcileRefund(req())).status, "needs_attention");
  });
});

test("an amount mismatch is an error, never silently accepted", async () => {
  await withPaystack({ "/refund/777": { status: true, data: { id: 777, status: "processed", amount: 5000 } } }, async (a) => {
    await assert.rejects(a.reconcileRefund(req({ providerRefundId: "777" })), /amount does not match/);
  });
});

test("the executor re-sends only when the lookup is complete and the first attempt is 10+ minutes old", () => {
  const src = fs.readFileSync("src/modules/payments/internal/refunds.server.ts", "utf8");
  assert.match(src, /adapter\.reconcileProvesAbsence === true && settled/);
  assert.match(src, /10 \* 60_000/);
  assert.equal(new PaystackPaymentAdapter("s", "https://x.test").reconcileProvesAbsence, true);
  assert.equal(new PaystackPaymentAdapter("s", "https://x.test").supportsIdempotentRefunds, false);
});

// Money audit H1: zero-commission orders and the Paystack split.
const single = { paymentId: "pay_1", attemptId: "attempt_123456789", amount: "265.00", currency: "GHS", method: "card",
  customerEmail: "buyer@example.com", idempotencyKey: "attempt_123456789", merchantSubaccount: "ACCT_merchant" };
async function initBody(extra) {
  let body;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ status: true, data: { reference: "attempt123456789", authorization_url: "https://checkout.paystack.com/x", access_code: "a" } });
  };
  try { await new PaystackPaymentAdapter("secret", "https://api.paystack.test").createPayment({ ...single, ...extra }); }
  finally { globalThis.fetch = original; }
  return body;
}

test("orders WITH commission are unchanged: transaction_charge, ELEMARKET bears the fee", async () => {
  const body = await initBody({ amount: "115.00", platformFee: "5.00" });
  assert.deepEqual([body.subaccount, body.transaction_charge, body.bearer, body.split], ["ACCT_merchant", 500, "account", undefined]);
});

test("zero commission, default: legacy payload (no split) until verified in the Paystack sandbox", async () => {
  delete process.env.ELEMARKET_PAYSTACK_EXPLICIT_ZERO_SPLIT;
  const body = await initBody({ platformFee: "0.00" });
  assert.deepEqual([body.subaccount, body.transaction_charge, body.split], ["ACCT_merchant", undefined, undefined]);
});

test("zero commission, switched on: the whole amount is assigned to the merchant explicitly", async () => {
  process.env.ELEMARKET_PAYSTACK_EXPLICIT_ZERO_SPLIT = "1";
  try {
    const body = await initBody({ platformFee: "0.00" });
    assert.equal(body.subaccount, undefined, "no dashboard-default split");
    assert.equal(body.transaction_charge, undefined);
    assert.deepEqual(body.split, { type: "flat", bearer_type: "account", subaccounts: [{ subaccount: "ACCT_merchant", share: 26500 }] });
    const withFee = await initBody({ amount: "115.00", platformFee: "5.00" });
    assert.equal(withFee.transaction_charge, 500, "commission orders still use the proven path");
  } finally { delete process.env.ELEMARKET_PAYSTACK_EXPLICIT_ZERO_SPLIT; }
});
