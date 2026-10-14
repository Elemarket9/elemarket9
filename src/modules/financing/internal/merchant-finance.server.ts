import { getSql } from "@/lib/db";
import type {
  MerchantFinanceProvider,
  MerchantFinanceSnapshot,
} from "@/modules/financing/internal/adapters/merchant-finance";

/**
 * Marketplace sales read-model adapter. Payment collection and settlement remain external.
 */
class MarketplaceSalesProvider implements MerchantFinanceProvider {
  async getSnapshot(merchantId: string): Promise<MerchantFinanceSnapshot> {
    const sql = await getSql();
    const sales = await sql.query<{
      total_sales: string;
      platform_commission: string;
      merchant_order_value: string;
    }>(`
      select
        coalesce(sum(case when status in ('paid','confirmed','fulfilling','shipped','delivered','completed') then product_total else 0 end),0)::text as total_sales,
        coalesce(sum(case when status in ('paid','confirmed','fulfilling','shipped','delivered','completed') then platform_fee else 0 end),0)::text as platform_commission,
        coalesce(sum(case when status in ('paid','confirmed','fulfilling','shipped','delivered','completed') then merchant_net else 0 end),0)::text as merchant_order_value
      from orders
      where merchant_id=$1
    `,[merchantId]);

    // Settlement is external. Do not read legacy local fund-release ledgers as if
    // they were a merchant balance or an amount ELEMARKET can release.
    const refundRequests = await sql.query<{
      id: string; order_id: string; amount: string; status: string; reason: string | null; requested_at: string; processed_at: string | null;
    }>(`
      select id, order_id, amount::text, status, reason,
             requested_at::text, processed_at::text
        from provider_refund_requests
       where order_id in (select id from orders where merchant_id=$1)
       order by requested_at desc limit 50
    `,[merchantId]);

    const withdrawalEligibilityRows = await sql.query<{ result: { eligibleAmount: string | number; eligibleOrders: number; activeDisputes: number; currency: string; custodyBoundary: string; withdrawalAction: string } }>(
      `select merchant_provider_withdrawal_eligibility($1) as result`,
      [merchantId],
    );
    const withdrawalEligibility = withdrawalEligibilityRows[0]?.result ?? {
      eligibleAmount: "0.00",
      eligibleOrders: 0,
      activeDisputes: 0,
      currency: "GHS",
      custodyBoundary: "external_provider",
      withdrawalAction: "provider_managed",
    };

    const row=sales[0] ?? { total_sales:"0.00", platform_commission:"0.00", merchant_order_value:"0.00" };
    return {
      balance: { currency:"GHS", totalSales:row.total_sales, platformCommission:row.platform_commission, merchantOrderValue:row.merchant_order_value, refundExceptionAmount: refundRequests.filter(d=>d.status === "needs_attention" || d.status === "failed").reduce((sum,d)=>sum+Number(d.amount||0),0).toFixed(2), providerHeldEligible: "0.00", providerRequestable: "0.00", pendingReleaseRequests: String(refundRequests.filter(d=>d.status === "requested" || d.status === "processing").length),
        providerWithdrawalEligibility: withdrawalEligibility,
      },
      refundRequests: refundRequests.map(d=>({ id:d.id, orderId:d.order_id, amount:d.amount, status:d.status, reason:d.reason ?? "Provider refund request", createdAt:d.requested_at, resolvedAt:d.processed_at })),
    };
  }
}

export function getMerchantFinanceProvider(): MerchantFinanceProvider {
  return new MarketplaceSalesProvider();
}
