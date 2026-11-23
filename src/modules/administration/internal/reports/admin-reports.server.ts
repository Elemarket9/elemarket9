// Back-office reports: read-only aggregate SQL over orders, payments, refunds,
// returns, delivery receipts and catalogue. Every query is parameterized and
// bounded by a validated date range (at most 366 days) and, for row lists, a LIMIT.
//
// Definitions (shown to staff on the page as well):
// - Paid order: an order whose payment reached 'completed' (the first
//   payment_state_transitions row to 'completed', written only by
//   apply_payment_webhook after the provider confirmed the charge), whose payment
//   is still completed or later refunded, and whose order was not cancelled. A
//   late payment on an already-cancelled checkout is excluded: it is a
//   reconciliation case, not a sale. Paid orders are dated by that payment time.
// - Day boundaries are Africa/Accra calendar days (UTC+0).
// - Delivered time: orders.customer_received_at, the receipt clock written from
//   the verified rider OTP handover (elemarket_order_delivered_at) and immutable
//   once set.
import { withTransaction, type Sql } from "@/lib/db";
import { REPORT_TIME_ZONE, validateReportRange, type ReportExportSection, type ReportRange } from "./report-range";
import { categoriesCsv, dailyCsv, merchantsCsv } from "./report-csv";

const TZ = REPORT_TIME_ZONE;
export const MERCHANT_REPORT_LIMIT = 50;
export const CATEGORY_REPORT_LIMIT = 200;

/** $1 = from date, $2 = to date (inclusive). Shared by every range-bound query. */
const PAID_CTE = `
with bounds as (
  select ($1::date::timestamp at time zone '${TZ}') as t0,
         (($2::date + 1)::timestamp at time zone '${TZ}') as t1
),
completed as (
  select t.payment_id, min(t.created_at) as paid_at
    from payment_state_transitions t, bounds b
   where t.to_status = 'completed' and t.created_at >= b.t0 and t.created_at < b.t1
   group by t.payment_id
),
paid as (
  select o.id, o.merchant_id, o.status, o.product_total, o.delivery_total, o.platform_fee,
         o.original_product_total, o.promo_discount, o.platform_funded_discount,
         o.merchant_net, o.grand_total, o.payment_timing, o.customer_received_at, c.paid_at,
         (c.paid_at at time zone '${TZ}')::date as paid_day,
         q.eta_minutes, (q.pickup_location_id is not null) as is_pickup,
         extract(epoch from (o.customer_received_at - c.paid_at)) / 60.0 as delivery_minutes,
         -- Timed delivery: paid up front, door delivery, received. Pay-on-delivery orders are
         -- paid at the door and pickup orders wait on the customer, so neither is timed.
         (o.payment_timing = 'upfront' and q.pickup_location_id is null and o.customer_received_at is not null) as timed,
         -- Cancelled after payment: refund requested or done before the customer ever received it.
         (o.status in ('refund_pending','refunded') and o.customer_received_at is null) as cancelled_after_payment
    from completed c
    join payments p on p.id = c.payment_id and p.status in ('completed','refunded')
    join orders o on o.id = p.order_id and o.status <> 'cancelled'
    join delivery_quotes q on q.id = o.delivery_quote_id
),
refunded as (
  select r.order_id, sum(r.amount) as amount
    from provider_refund_requests r
    join paid on paid.id = r.order_id
   where r.status = 'processed'
   group by r.order_id
)`;

const pct = (num: string, den: string) => `round(100.0 * (${num}) / nullif(${den}, 0), 2)::text`;

export type SalesReport = {
  orders: number;
  gmv: string;
  deliveryFees: string;
  commission: string;
  merchantEarnings: string;
  amountPaid: string;
  averageOrderValue: string | null;
  /** Discount paid by ELEMARKET (marketplace promotions). */
  elemarketPromotions: string;
  /** Discount paid by merchants (their own coupons). */
  merchantPromotions: string;
  /** Commission before ELEMARKET-funded discounts. */
  grossCommission: string;
  /** Paid orders later fully refunded (counted in the totals above). */
  refundedOrders: number;
  refundedAmount: string;
  /** Commission and merchant earnings with refunded orders taken out. */
  commissionAfterRefunds: string;
  merchantEarningsAfterRefunds: string;
  daily: Array<{ day: string; orders: number; gmv: string; deliveryFees: string; commission: string; merchantEarnings: string }>;
};

export type RefundReport = {
  requested: {
    processedCount: number; processedAmount: string;
    pendingCount: number; pendingAmount: string;
    failedCount: number; failedAmount: string;
  };
  paidOrders: number;
  paidValue: string;
  refundedOrders: number;
  refundedValue: string;
  refundRateByCount: string | null;
  refundRateByValue: string | null;
  cancelledAfterPayment: number;
  cancelledAfterPaymentRate: string | null;
  ordersPlaced: number;
  unpaidCancelled: number;
  unpaidCancelledRate: string | null;
  returns: { opened: number; approved: number; refunded: number };
};

export type DeliveryReport = {
  doorOrders: number;
  pickupOrders: number;
  timedDeliveries: number;
  medianMinutes: string | null;
  p90Minutes: string | null;
  withinEta: number;
  withinEtaRate: string | null;
  currentlyLate: number;
};

export type MerchantReportRow = {
  merchantId: string;
  merchantName: string;
  orders: number;
  gmv: string;
  refundRate: string | null;
  cancellationRate: string | null;
  medianDeliveryMinutes: string | null;
  openRiskFlags: number;
};

export type CategoryReportRow = { categoryKey: string; categoryName: string; orders: number; units: number; gmv: string };

export type AdminReport = {
  range: ReportRange;
  timeZone: string;
  generatedAt: string;
  sales: SalesReport;
  refunds: RefundReport;
  delivery: DeliveryReport;
  merchants: MerchantReportRow[];
  categories: CategoryReportRow[];
};

export async function loadSalesReport(sql: Sql, range: ReportRange): Promise<SalesReport> {
  const [totals] = await sql.query<{
    orders: number; gmv: string; delivery_fees: string; commission: string; merchant_earnings: string;
    amount_paid: string; aov: string | null; elemarket_promotions: string; merchant_promotions: string;
    gross_commission: string; refunded_orders: number; refunded_amount: string;
    commission_after_refunds: string; merchant_earnings_after_refunds: string;
  }>(
    `${PAID_CTE}
     select count(*)::int as orders,
            -- GMV is merchandise value at list price, before any promotion.
            coalesce(sum(original_product_total), 0)::text as gmv,
            coalesce(sum(platform_funded_discount), 0)::text as elemarket_promotions,
            coalesce(sum(promo_discount - platform_funded_discount), 0)::text as merchant_promotions,
            coalesce(sum(platform_fee + platform_funded_discount), 0)::text as gross_commission,
            count(*) filter (where status = 'refunded')::int as refunded_orders,
            coalesce(sum(grand_total) filter (where status = 'refunded'), 0)::text as refunded_amount,
            coalesce(sum(platform_fee) filter (where status <> 'refunded'), 0)::text as commission_after_refunds,
            coalesce(sum(merchant_net) filter (where status <> 'refunded'), 0)::text as merchant_earnings_after_refunds,
            coalesce(sum(delivery_total), 0)::text as delivery_fees,
            coalesce(sum(platform_fee), 0)::text as commission,
            coalesce(sum(merchant_net), 0)::text as merchant_earnings,
            coalesce(sum(grand_total), 0)::text as amount_paid,
            round(sum(grand_total) / nullif(count(*), 0), 2)::text as aov
       from paid`,
    [range.from, range.to],
  );
  const daily = await sql.query<{
    day: string; orders: number; gmv: string; delivery_fees: string; commission: string; merchant_earnings: string;
  }>(
    `${PAID_CTE},
     days as (select d::date as day from generate_series($1::date, $2::date, interval '1 day') d)
     select to_char(days.day, 'YYYY-MM-DD') as day,
            count(paid.id)::int as orders,
            coalesce(sum(paid.original_product_total), 0)::text as gmv,
            coalesce(sum(paid.delivery_total), 0)::text as delivery_fees,
            coalesce(sum(paid.platform_fee), 0)::text as commission,
            coalesce(sum(paid.merchant_net), 0)::text as merchant_earnings
       from days left join paid on paid.paid_day = days.day
      group by days.day
      order by days.day
      limit 366`,
    [range.from, range.to],
  );
  return {
    orders: totals?.orders ?? 0,
    gmv: totals?.gmv ?? "0",
    deliveryFees: totals?.delivery_fees ?? "0",
    commission: totals?.commission ?? "0",
    merchantEarnings: totals?.merchant_earnings ?? "0",
    amountPaid: totals?.amount_paid ?? "0",
    averageOrderValue: totals?.aov ?? null,
    elemarketPromotions: totals?.elemarket_promotions ?? "0",
    merchantPromotions: totals?.merchant_promotions ?? "0",
    grossCommission: totals?.gross_commission ?? "0",
    refundedOrders: totals?.refunded_orders ?? 0,
    refundedAmount: totals?.refunded_amount ?? "0",
    commissionAfterRefunds: totals?.commission_after_refunds ?? "0",
    merchantEarningsAfterRefunds: totals?.merchant_earnings_after_refunds ?? "0",
    daily: daily.map((d) => ({
      day: d.day, orders: d.orders, gmv: d.gmv, deliveryFees: d.delivery_fees,
      commission: d.commission, merchantEarnings: d.merchant_earnings,
    })),
  };
}

export async function loadRefundReport(sql: Sql, range: ReportRange): Promise<RefundReport> {
  const params = [range.from, range.to];
  // Refund requests opened in the range, by their current state.
  const [requested] = await sql.query<{
    processed_count: number; processed_amount: string; pending_count: number; pending_amount: string;
    failed_count: number; failed_amount: string;
  }>(
    `with bounds as (
       select ($1::date::timestamp at time zone '${TZ}') as t0,
              (($2::date + 1)::timestamp at time zone '${TZ}') as t1
     )
     select count(*) filter (where r.status = 'processed')::int as processed_count,
            coalesce(sum(r.amount) filter (where r.status = 'processed'), 0)::text as processed_amount,
            count(*) filter (where r.status in ('requested','processing','needs_attention'))::int as pending_count,
            coalesce(sum(r.amount) filter (where r.status in ('requested','processing','needs_attention')), 0)::text as pending_amount,
            count(*) filter (where r.status = 'failed')::int as failed_count,
            coalesce(sum(r.amount) filter (where r.status = 'failed'), 0)::text as failed_amount
       from provider_refund_requests r, bounds b
      where r.requested_at >= b.t0 and r.requested_at < b.t1`,
    params,
  );
  // Of the orders paid in the range: how many were refunded / cancelled after payment.
  const [cohort] = await sql.query<{
    paid_orders: number; paid_value: string; refunded_orders: number; refunded_value: string;
    refund_rate_count: string | null; refund_rate_value: string | null; cancelled: number; cancelled_rate: string | null;
  }>(
    `${PAID_CTE}
     select count(*)::int as paid_orders,
            coalesce(sum(paid.grand_total), 0)::text as paid_value,
            count(refunded.order_id)::int as refunded_orders,
            coalesce(sum(refunded.amount), 0)::text as refunded_value,
            ${pct("count(refunded.order_id)", "count(*)")} as refund_rate_count,
            ${pct("coalesce(sum(refunded.amount), 0)", "sum(paid.grand_total)")} as refund_rate_value,
            count(*) filter (where paid.cancelled_after_payment)::int as cancelled,
            ${pct("count(*) filter (where paid.cancelled_after_payment)", "count(*)")} as cancelled_rate
       from paid left join refunded on refunded.order_id = paid.id`,
    params,
  );
  // Checkouts placed in the range that were cancelled or expired without a payment.
  const [placed] = await sql.query<{ placed: number; cancelled: number; rate: string | null }>(
    `with bounds as (
       select ($1::date::timestamp at time zone '${TZ}') as t0,
              (($2::date + 1)::timestamp at time zone '${TZ}') as t1
     ),
     placed as (
       select o.status = 'cancelled'
                and not exists (select 1 from payments p where p.order_id = o.id and p.status in ('completed','refunded'))
                as unpaid_cancelled
         from orders o, bounds b
        where o.created_at >= b.t0 and o.created_at < b.t1
     )
     select count(*)::int as placed,
            count(*) filter (where unpaid_cancelled)::int as cancelled,
            ${pct("count(*) filter (where unpaid_cancelled)", "count(*)")} as rate
       from placed`,
    params,
  );
  // Return requests opened in the range, by how far they got.
  const [returns] = await sql.query<{ opened: number; approved: number; refunded: number }>(
    `with bounds as (
       select ($1::date::timestamp at time zone '${TZ}') as t0,
              (($2::date + 1)::timestamp at time zone '${TZ}') as t1
     )
     select count(*)::int as opened,
            count(*) filter (where r.status in ('approved','received','refund_pending','refunded'))::int as approved,
            count(*) filter (where r.status = 'refunded')::int as refunded
       from return_requests r, bounds b
      where r.created_at >= b.t0 and r.created_at < b.t1`,
    params,
  );
  return {
    requested: {
      processedCount: requested?.processed_count ?? 0, processedAmount: requested?.processed_amount ?? "0",
      pendingCount: requested?.pending_count ?? 0, pendingAmount: requested?.pending_amount ?? "0",
      failedCount: requested?.failed_count ?? 0, failedAmount: requested?.failed_amount ?? "0",
    },
    paidOrders: cohort?.paid_orders ?? 0,
    paidValue: cohort?.paid_value ?? "0",
    refundedOrders: cohort?.refunded_orders ?? 0,
    refundedValue: cohort?.refunded_value ?? "0",
    refundRateByCount: cohort?.refund_rate_count ?? null,
    refundRateByValue: cohort?.refund_rate_value ?? null,
    cancelledAfterPayment: cohort?.cancelled ?? 0,
    cancelledAfterPaymentRate: cohort?.cancelled_rate ?? null,
    ordersPlaced: placed?.placed ?? 0,
    unpaidCancelled: placed?.cancelled ?? 0,
    unpaidCancelledRate: placed?.rate ?? null,
    returns: { opened: returns?.opened ?? 0, approved: returns?.approved ?? 0, refunded: returns?.refunded ?? 0 },
  };
}

export async function loadDeliveryReport(sql: Sql, range: ReportRange): Promise<DeliveryReport> {
  const [row] = await sql.query<{
    door_orders: number; pickup_orders: number; timed: number; median: string | null; p90: string | null;
    within_eta: number; within_eta_rate: string | null;
  }>(
    `${PAID_CTE}
     select count(*) filter (where not is_pickup)::int as door_orders,
            count(*) filter (where is_pickup)::int as pickup_orders,
            count(*) filter (where timed)::int as timed,
            round((percentile_cont(0.5) within group (order by delivery_minutes) filter (where timed))::numeric, 1)::text as median,
            round((percentile_cont(0.9) within group (order by delivery_minutes) filter (where timed))::numeric, 1)::text as p90,
            count(*) filter (where timed and delivery_minutes <= eta_minutes)::int as within_eta,
            ${pct("count(*) filter (where timed and delivery_minutes <= eta_minutes)", "count(*) filter (where timed)")} as within_eta_rate
       from paid`,
    [range.from, range.to],
  );
  // Live snapshot (not range-bound): door deliveries paid up front, still open and past
  // their quoted ETA counted from payment. Open orders are a small, status-indexed set.
  const [late] = await sql.query<{ late: number }>(
    `select count(*)::int as late
       from orders o
       join payments p on p.order_id = o.id and p.status = 'completed'
       join delivery_quotes q on q.id = o.delivery_quote_id and q.pickup_location_id is null
       join lateral (
         select min(t.created_at) as paid_at from payment_state_transitions t
          where t.payment_id = p.id and t.to_status = 'completed'
       ) c on c.paid_at is not null
      where o.status in ('paid','confirmed','fulfilling','shipped')
        and o.payment_timing = 'upfront'
        and o.customer_received_at is null
        and c.paid_at + make_interval(mins => q.eta_minutes) < now()`,
  );
  return {
    doorOrders: row?.door_orders ?? 0,
    pickupOrders: row?.pickup_orders ?? 0,
    timedDeliveries: row?.timed ?? 0,
    medianMinutes: row?.median ?? null,
    p90Minutes: row?.p90 ?? null,
    withinEta: row?.within_eta ?? 0,
    withinEtaRate: row?.within_eta_rate ?? null,
    currentlyLate: late?.late ?? 0,
  };
}

/** LIKE pattern for a merchant name/ID search, with wildcards in the input escaped. */
export function merchantSearchPattern(search: string | null | undefined): string | null {
  const term = (search ?? "").trim().slice(0, 100);
  if (!term) return null;
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function loadMerchantReport(sql: Sql, range: ReportRange, search?: string | null): Promise<MerchantReportRow[]> {
  const rows = await sql.query<{
    merchant_id: string; merchant_name: string; orders: number; gmv: string; refund_rate: string | null;
    cancellation_rate: string | null; median_minutes: string | null; open_risk_flags: number;
  }>(
    `${PAID_CTE},
     per_merchant as (
       select paid.merchant_id,
              count(*) as orders,
              sum(paid.original_product_total) as gmv,
              count(refunded.order_id) as refunded_orders,
              count(*) filter (where paid.cancelled_after_payment) as cancelled,
              percentile_cont(0.5) within group (order by paid.delivery_minutes) filter (where paid.timed) as median_minutes
         from paid left join refunded on refunded.order_id = paid.id
        group by paid.merchant_id
     ),
     open_risk as (
       select f.subject_id as merchant_id, count(*) as n
         from risk_flags f
         join per_merchant pm on pm.merchant_id = f.subject_id
        where f.subject_type = 'merchant' and f.status = 'open'
        group by f.subject_id
     )
     select pm.merchant_id, m.name as merchant_name, pm.orders::int as orders, pm.gmv::text as gmv,
            ${pct("pm.refunded_orders", "pm.orders")} as refund_rate,
            ${pct("pm.cancelled", "pm.orders")} as cancellation_rate,
            round(pm.median_minutes::numeric, 1)::text as median_minutes,
            coalesce(r.n, 0)::int as open_risk_flags
       from per_merchant pm
       join merchants m on m.id = pm.merchant_id
       left join open_risk r on r.merchant_id = pm.merchant_id
      where $3::text is null or m.name ilike $3::text escape '\\' or m.id ilike $3::text escape '\\'
      order by pm.gmv desc, pm.merchant_id
      limit ${MERCHANT_REPORT_LIMIT}`,
    [range.from, range.to, merchantSearchPattern(search)],
  );
  return rows.map((r) => ({
    merchantId: r.merchant_id, merchantName: r.merchant_name, orders: r.orders, gmv: r.gmv,
    refundRate: r.refund_rate, cancellationRate: r.cancellation_rate,
    medianDeliveryMinutes: r.median_minutes, openRiskFlags: r.open_risk_flags,
  }));
}

export async function loadCategoryReport(sql: Sql, range: ReportRange): Promise<CategoryReportRow[]> {
  // Category is the product's current category: order lines do not snapshot it.
  const rows = await sql.query<{ category_key: string; category_name: string; orders: number; units: number; gmv: string }>(
    `${PAID_CTE}
     select pr.category as category_key,
            coalesce(ct.name, pr.category) as category_name,
            count(distinct oi.order_id)::int as orders,
            sum(oi.quantity)::int as units,
            sum(oi.product_total)::text as gmv
       from paid
       join order_items oi on oi.order_id = paid.id
       join products pr on pr.id = oi.product_id
       left join category_taxonomy ct on ct.category_key = pr.category
      group by pr.category, ct.name
      order by sum(oi.product_total) desc, pr.category
      limit ${CATEGORY_REPORT_LIMIT}`,
    [range.from, range.to],
  );
  return rows.map((r) => ({ categoryKey: r.category_key, categoryName: r.category_name, orders: r.orders, units: r.units, gmv: r.gmv }));
}

export async function loadAdminReport(sql: Sql, input: { from: string; to: string; search?: string | null }): Promise<AdminReport> {
  const range = validateReportRange(input);
  // Independent read-only sections: run side by side on the pool (a fixed 5 queries at a time).
  const [sales, refunds, delivery, merchants, categories] = await Promise.all([
    loadSalesReport(sql, range),
    loadRefundReport(sql, range),
    loadDeliveryReport(sql, range),
    loadMerchantReport(sql, range, input.search),
    loadCategoryReport(sql, range),
  ]);
  return { range, timeZone: REPORT_TIME_ZONE, generatedAt: new Date().toISOString(), sales, refunds, delivery, merchants, categories };
}

/**
 * CSV for one export section, audited as "admin.report.exported" with the range
 * and section only (no row data). The audit is written before the CSV is
 * returned: if it cannot be recorded, nothing is exported.
 */
export async function buildReportExport(
  sql: Sql,
  input: { from: string; to: string; section: ReportExportSection; search?: string | null; actorId: string },
): Promise<{ filename: string; csv: string }> {
  const range = validateReportRange(input);
  let csv: string;
  let rowCount: number;
  if (input.section === "daily") {
    const sales = await loadSalesReport(sql, range);
    csv = dailyCsv(sales.daily); rowCount = sales.daily.length;
  } else if (input.section === "merchants") {
    const rows = await loadMerchantReport(sql, range, input.search);
    csv = merchantsCsv(rows); rowCount = rows.length;
  } else if (input.section === "categories") {
    const rows = await loadCategoryReport(sql, range);
    csv = categoriesCsv(rows); rowCount = rows.length;
  } else {
    throw new Error("Unknown report section");
  }
  await withTransaction(async (tx) => {
    await tx.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
      "admin.report.exported", "report", input.section, input.actorId, "admin", null, "success",
      JSON.stringify({
        section: input.section, from: range.from, to: range.to, days: range.days,
        filtered: Boolean(input.section === "merchants" && input.search?.trim()), rowCount,
      }),
    ]);
  });
  return { filename: `elemarket-${input.section}-${range.from}-to-${range.to}.csv`, csv };
}
