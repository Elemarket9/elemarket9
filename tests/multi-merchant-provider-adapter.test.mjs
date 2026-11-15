import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "../scripts/helpers/load-typescript.mjs";
import { marketplaceSettlementChargePesewas } from "../src/lib/commerce-guards.mjs";

const { PaystackPaymentAdapter } = loadTypeScript("src/modules/payments/internal/adapters/providers/paystack.ts", {
  "@/lib/security/body.server": { readResponseBodyWithLimit: (response) => response.text() },
  "@/lib/commerce-guards.mjs": { marketplaceSettlementChargePesewas },
  "@/modules/payments/internal/payment-errors": { PaymentProviderError: class PaymentProviderError extends Error {} },
});
const plan = { amountMinor: 38000, platformMinor: 6500,
  subaccounts: [{ subaccount: "sub1", share: 13500 }, { subaccount: "sub2", share: 18000 }] };
const args = { paymentId: "group_payment_123", attemptId: "group_attempt_12345", amount: "380.00",
  currency: "GHS", method: "mobile_money", customerEmail: "buyer@example.com",
  idempotencyKey: "group_attempt_12345", multiMerchantSplit: plan };

test("dynamic split sends one provider charge with exact vendor shares and no second provider call", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ status: true, data: {
      reference: "groupattempt12345", authorization_url: "https://checkout.paystack.com/group",
      access_code: "access_123",
    } });
  };
  try {
    const adapter = new PaystackPaymentAdapter("secret", "https://api.paystack.test");
    assert.equal(adapter.supportsMultiMerchantSplit, true);
    const result = await adapter.createPayment(args);
    assert.equal(result.checkoutUrl, "https://checkout.paystack.com/group");
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.amount, "38000");
    assert.equal(body.subaccount, undefined);
    assert.equal(body.transaction_charge, undefined);
    assert.deepEqual(body.split, {
      type: "flat", bearer_type: "account", subaccounts: [
        { subaccount: "sub1", share: 13500 }, { subaccount: "sub2", share: 18000 },
      ],
    });
    assert.equal(calls[0].init.headers["idempotency-key"], "group_attempt_12345");
  } finally { globalThis.fetch = original; }
});

test("provider refuses allocation drift or conflicting single merchant subaccount", async () => {
  const adapter = new PaystackPaymentAdapter("secret", "https://api.paystack.test");
  for (const unsafe of [
    { ...plan, amountMinor: 38001 },
    { ...plan, platformMinor: 6400 },
    { ...plan, subaccounts: [{ subaccount: "sub1", share: 20000 }, { subaccount: "sub1", share: 11500 }] },
    { ...plan, subaccounts: [{ subaccount: "sub1", share: -100 }, { subaccount: "sub2", share: 31600 }] },
    { ...plan, subaccounts: [{ subaccount: "sub1", share: 10.5 }, { subaccount: "sub2", share: 31489.5 }] },
  ]) await assert.rejects(adapter.createPayment({ ...args, multiMerchantSplit: unsafe }));
  await assert.rejects(adapter.createPayment({ ...args, merchantSubaccount: "sub1" }));
  await assert.rejects(adapter.requestMobileMoneyPrompt({ ...args, phone: "+233200000000", network: "mtn" }));
});


test("uncertain group initialization cannot be recovered on matching total without proving seller allocations", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ status: false, data: null }, { status: 503 });
  };
  try {
    const adapter = new PaystackPaymentAdapter("secret", "https://api.paystack.test");
    await assert.rejects(adapter.createPayment(args), /requires verified provider split reconciliation/);
    assert.equal(calls.length, 1, "must not infer subaccount payouts from amount-only verification");
  } finally { globalThis.fetch = original; }
});
