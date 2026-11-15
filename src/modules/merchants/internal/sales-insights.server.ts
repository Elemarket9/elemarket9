import { getSql } from "@/lib/db";

export type SalesInsightDay = {
  day: string; orders: number; productSales: string; commission: string; merchantValue: string;
};
export type SalesInsightProduct = { productId: string; productName: string; units: number; productSales: string };

/**
 * Paid-order operational analytics, scoped to one authorized merchant.
 * These figures are BEFORE partial refunds, chargebacks and payout fees.
 * Financial ledger statements remain authoritative for actual withdrawals.
 */
export async function getMerchantSalesInsights(merchantId: string, days: 7 | 30 | 90) {
  const sql = await getSql();
  const paid = ["paid", "confirmed", "fulfilling", "shipped", "delivered", "completed"];
  const [daily, topProducts, summary] = await Promise.all([
    sql.query<SalesInsightDay>(
      `with days as (
         select (current_date - n)::date as day from generate_series(0, $2::int - 1) as n
       )
       select to_char(d.day, 'YYYY-MM-DD') as day,
              count(o.id)::int as orders,
              coalesce(sum(o.product_total),0)::text as "productSales",
              coalesce(sum(o.platform_fee),0)::text as commission,
              coalesce(sum(o.merchant_net),0)::text as "merchantValue"
         from days d left join orders o
           on o.merchant_id=$1
          and o.created_at >= d.day and o.created_at < d.day + interval '1 day'
          and o.status = any($3::text[])
        group by d.day order by d.day asc`,
      [merchantId, days, paid],
    ),
    sql.query<SalesInsightProduct>(
      `select p.id as "productId", p.name as "productName",
              sum(oi.quantity)::int as units,
              coalesce(sum(oi.product_total),0)::text as "productSales"
         from order_items oi
         join orders o on o.id=oi.order_id
         join products p on p.id=oi.product_id and p.merchant_id=o.merchant_id
        where o.merchant_id=$1 and o.status = any($3::text[])
          and o.created_at >= current_date - ($2::int - 1)
        group by p.id,p.name order by sum(oi.product_total) desc, p.id limit 10`,
      [merchantId, days, paid],
    ),
    sql.query<{ orders: number; productSales: string; commission: string; merchantValue: string }>(
      `select count(*)::int as orders,
              coalesce(sum(product_total),0)::text as "productSales",
              coalesce(sum(platform_fee),0)::text as commission,
              coalesce(sum(merchant_net),0)::text as "merchantValue"
         from orders
        where merchant_id=$1 and status = any($3::text[])
          and created_at >= current_date - ($2::int - 1)`,
      [merchantId, days, paid],
    ),
  ]);
  return {
    days,
    summary: summary[0] ?? { orders: 0, productSales: "0.00", commission: "0.00", merchantValue: "0.00" },
    daily,
    topProducts,
    basis: "paid_orders_before_refund_adjustments" as const,
  };
}
