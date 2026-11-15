import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "../scripts/helpers/load-typescript.mjs";

const { planMultiMerchantSplit } = loadTypeScript("src/modules/payments/internal/multi-merchant-split.ts");
const first = { orderId: "order1", merchantId: "seller1", providerSubaccount: "sub1", currency: "GHS",
  productTotal: "150.00", deliveryTotal: "10.00", platformFee: "15.00", merchantNet: "135.00", grandTotal: "160.00" };
const second = { orderId: "order2", merchantId: "seller2", providerSubaccount: "sub2", currency: "GHS",
  productTotal: "200.00", deliveryTotal: "20.00", platformFee: "20.00", merchantNet: "180.00", grandTotal: "220.00" };

test("a single group charge splits exact GH₵380.00 across two merchants without platform custody of seller shares", () => {
  const plan = planMultiMerchantSplit([first, second]);
  assert.equal(plan.amountMinor, 38000);
  assert.equal(plan.merchantMinor, 31500);
  assert.equal(plan.platformMinor, 6500);
  assert.deepEqual(plan.subaccounts, [{ subaccount: "sub1", share: 13500 }, { subaccount: "sub2", share: 18000 }]);
  assert.equal(plan.allocations.reduce((sum, row) => sum + row.amountMinor, 0), plan.amountMinor);
  assert.equal(plan.merchantMinor + plan.platformMinor, plan.amountMinor);
});

test("exact pesewa arithmetic preserves uneven splits", () => {
  const plan = planMultiMerchantSplit([
    { ...first, productTotal: "0.03", merchantNet: "0.02", platformFee: "0.01", deliveryTotal: "0.01", grandTotal: "0.04" },
    { ...second, productTotal: "0.05", merchantNet: "0.04", platformFee: "0.01", deliveryTotal: "0.01", grandTotal: "0.06" },
  ]);
  assert.equal(plan.amountMinor, 10);
  assert.equal(plan.merchantMinor, 6);
  assert.equal(plan.platformMinor, 4);
});

test("multi-seller splits reject duplicates, unverifiable settlement, and hidden allocation drift", () => {
  for (const invalid of [
    [first],
    [first, { ...second, merchantId: first.merchantId }],
    [first, { ...second, orderId: first.orderId }],
    [first, { ...second, providerSubaccount: first.providerSubaccount }],
    [first, { ...second, currency: "USD" }],
    [first, { ...second, merchantNet: "181.00" }],
    [first, { ...second, platformFee: "21.00" }],
    [first, { ...second, grandTotal: "219.99" }],
    [first, { ...second, productTotal: "-200.00" }],
    [first, { ...second, merchantNet: "0.00" }],
    [first, { ...second, productTotal: "200.001" }],
  ]) assert.throws(() => planMultiMerchantSplit(invalid), undefined, JSON.stringify(invalid));
});
