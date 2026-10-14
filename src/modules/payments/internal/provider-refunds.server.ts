import { getSql } from "@/lib/db";
import { requireMerchantAccess } from "@/modules/identity/public/auth/authorization.server";

/** Provider-managed refund operations. ELEMARKET never owns or releases funds. */
export async function getMerchantProviderRefunds(merchantId: string, bearerToken?: string) {
  await requireMerchantAccess(merchantId, bearerToken);
  const sql = await getSql();
  return sql.query(`
    select r.id, r.order_id, r.payment_id, r.amount::text as amount, r.currency,
           r.status, r.reason, r.provider_refund_id, r.requested_at, r.processed_at
      from provider_refund_requests r
      join orders o on o.id=r.order_id
     where o.merchant_id=$1
     order by r.requested_at desc
     limit 100
  `, [merchantId]);
}
