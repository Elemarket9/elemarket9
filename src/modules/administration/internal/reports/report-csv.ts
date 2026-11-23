// CSV layouts for the report exports. Pure: no server imports.
import { toCsv } from "./report-range";

type Daily = { day: string; orders: number; gmv: string; deliveryFees: string; commission: string; merchantEarnings: string };
type Merchant = {
  merchantId: string; merchantName: string; orders: number; gmv: string; refundRate: string | null;
  cancellationRate: string | null; medianDeliveryMinutes: string | null; openRiskFlags: number;
};
type Category = { categoryKey: string; categoryName: string; orders: number; units: number; gmv: string };

export function dailyCsv(rows: Daily[]): string {
  return toCsv(
    ["date_accra", "paid_orders", "gmv_ghs", "delivery_fees_ghs", "elemarket_commission_ghs", "merchant_earnings_ghs"],
    rows.map((r) => [r.day, r.orders, r.gmv, r.deliveryFees, r.commission, r.merchantEarnings]),
  );
}

export function merchantsCsv(rows: Merchant[]): string {
  return toCsv(
    ["merchant_id", "merchant_name", "paid_orders", "gmv_ghs", "refund_rate_pct", "cancellation_rate_pct", "median_delivery_minutes", "open_risk_flags"],
    rows.map((r) => [r.merchantId, r.merchantName, r.orders, r.gmv, r.refundRate, r.cancellationRate, r.medianDeliveryMinutes, r.openRiskFlags]),
  );
}

export function categoriesCsv(rows: Category[]): string {
  return toCsv(
    ["category_key", "category_name", "paid_orders", "units", "gmv_ghs"],
    rows.map((r) => [r.categoryKey, r.categoryName, r.orders, r.units, r.gmv]),
  );
}
