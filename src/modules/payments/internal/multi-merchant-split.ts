/**
 * Immutable provider-neutral split plan. The customer is charged once;
 * each seller's merchandise entitlement goes to its provider subaccount,
 * and the provider account retains platform commission plus delivery fees.
 *
 * This is a planning contract, NOT evidence that a group payment has settled.
 * Payment processing must atomically settle all member orders and identify
 * partial refunds against the original group provider transaction.
 */
export type MarketplaceSplitOrder = {
  orderId: string;
  merchantId: string;
  providerSubaccount: string;
  currency: string;
  productTotal: string;
  deliveryTotal: string;
  platformFee: string;
  merchantNet: string;
  grandTotal: string;
};

export type MarketplaceSplitPlan = {
  currency: "GHS";
  amountMinor: number;
  merchantMinor: number;
  platformMinor: number;
  subaccounts: Array<{ subaccount: string; share: number }>;
  allocations: Array<{ orderId: string; merchantId: string; subaccount: string; amountMinor: number; merchantMinor: number }>;
};

function exactMoney(value: string): number {
  if (!/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/.test(value)) throw new Error("Invalid checkout money");
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error("Checkout money exceeds safe limits");
  return cents;
}

export function planMultiMerchantSplit(orders: readonly MarketplaceSplitOrder[]): MarketplaceSplitPlan {
  if (orders.length < 2 || orders.length > 40) throw new Error("Group split requires 2–40 merchant orders");
  const orderIds = new Set<string>(), merchantIds = new Set<string>(), accounts = new Set<string>();
  let amountMinor = 0, merchantMinor = 0, platformMinor = 0;
  const allocations: MarketplaceSplitPlan["allocations"] = [];
  const subaccounts: MarketplaceSplitPlan["subaccounts"] = [];
  for (const o of orders) {
    if (!o.orderId || !o.merchantId || !o.providerSubaccount ||
        o.orderId.length > 128 || o.merchantId.length > 128 ||
        o.providerSubaccount.length > 256 || o.currency !== "GHS") {
      throw new Error("Incomplete or mixed-currency merchant split");
    }
    if (orderIds.has(o.orderId) || merchantIds.has(o.merchantId) || accounts.has(o.providerSubaccount)) {
      throw new Error("Duplicate merchant, order or provider payout account");
    }
    orderIds.add(o.orderId); merchantIds.add(o.merchantId); accounts.add(o.providerSubaccount);
    const product = exactMoney(o.productTotal), delivery = exactMoney(o.deliveryTotal);
    const commission = exactMoney(o.platformFee), seller = exactMoney(o.merchantNet);
    const gross = exactMoney(o.grandTotal);
    if (gross <= 0 || product + delivery !== gross ||
        commission + seller !== product || seller <= 0 || delivery < 0) {
      throw new Error("Provider split does not reconcile to authoritative order amounts");
    }
    amountMinor += gross;
    merchantMinor += seller;
    platformMinor += commission + delivery;
    if (![amountMinor,merchantMinor,platformMinor].every(Number.isSafeInteger)) throw new Error("Group amount overflow");
    subaccounts.push({ subaccount: o.providerSubaccount, share: seller });
    allocations.push({ orderId: o.orderId, merchantId: o.merchantId, subaccount: o.providerSubaccount, amountMinor: gross, merchantMinor: seller });
  }
  if (merchantMinor + platformMinor !== amountMinor || platformMinor < 0) throw new Error("Group payment allocations do not balance");
  return { currency: "GHS", amountMinor, merchantMinor, platformMinor, subaccounts, allocations };
}
