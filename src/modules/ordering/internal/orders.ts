import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireCustomerForUserId, requireMerchantOrAdminForUserId, requireMerchantAccessForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireCustomerOrder, requireMerchantOrder } from "@/modules/ordering/internal/ownership.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import type { JsonObject } from "@/lib/db-types";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";

const orderIdSchema = z.object({ orderId: z.string().min(1).max(128) });
const merchantOrderSchema = z.object({ orderId: z.string().min(1).max(128), merchantId: z.string().min(1).max(128) });

type OrderItemRow = {
  id: string;
  product_id: string;
  product_name: string;
  image_path: string | null;
  variant_id: string | null;
  quantity: number;
  unit_price: string;
  currency: string;
  product_total: string;
};


const customerOrdersSchema = z.object({
  cursor: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const listCustomerOrders = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(customerOrdersSchema)
  .handler(async ({ data, context }) => {
    await requireCustomerForUserId(context.userId);
    const userId = getAuthenticatedUserId(context);
    const sql = await getSql();
    const limit = Math.min(data.limit, 50);
    const rows = await sql.query<{
      id:string; status:string; currency:string; product_total:string; delivery_total:string; grand_total:string;
      created_at:string; updated_at:string; delivered_at:string|null; dispute_status:string|null; dispute_created_at:string|null;
    }>(`select o.id,o.status,o.currency,o.product_total::text,o.delivery_total::text,o.grand_total::text,
              o.created_at::text,o.updated_at::text,
              elemarket_order_delivered_at(o.id)::text as delivered_at,
              d.status as dispute_status,d.created_at::text as dispute_created_at
         from orders o
         left join lateral (select status,created_at from customer_order_disputes where order_id=o.id order by created_at desc limit 1) d on true
        where o.user_id=$1 and ($2::timestamptz is null or o.created_at < $2::timestamptz)
        order by o.created_at desc
        limit $3`, [userId, data.cursor ?? null, limit + 1]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      orders: page.map(r => ({ id:r.id,status:r.status,currency:r.currency,productTotal:r.product_total,deliveryTotal:r.delivery_total,grandTotal:r.grand_total,createdAt:r.created_at,updatedAt:r.updated_at,deliveredAt:r.delivered_at,disputeStatus:r.dispute_status,disputeCreatedAt:r.dispute_created_at })),
      nextCursor: hasMore ? page[page.length-1]?.created_at ?? null : null,
    };
  });

/** Recover unfinished merchant payments from the database, not browser storage. */
export const listCustomerPendingPayments = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ groupId: z.string().min(1).max(128), limit: z.number().int().min(1).max(30).default(20) }))
  .handler(async ({ data, context }) => {
    await requireCustomerForUserId(context.userId);
    const userId = getAuthenticatedUserId(context);
    await enforceRateLimit("customer-pending-payments", { windowSeconds: 60, maxRequests: 20, subject: userId });
    const sql = await getSql();
    const rows = await sql.query<{ payment_id: string; order_id: string; created_at: string }>(
      `select p.id as payment_id, o.id as order_id, o.created_at::text
         from payments p join orders o on o.id = p.order_id
        where o.user_id = $1 and o.group_id = $2 and p.status = 'initiated'
        order by o.created_at asc, p.id asc limit $3`,
      [userId, data.groupId, data.limit],
    );
    return { payments: rows.map(row => ({ paymentId: row.payment_id, orderId: row.order_id, createdAt: row.created_at })) };
  });

export const getCustomerOrder = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(orderIdSchema)
  .handler(async ({ data, context }) => {
    await requireCustomerForUserId(context.userId);
    const userId = getAuthenticatedUserId(context);
    const order = await requireCustomerOrder(data.orderId, userId);
    const sql = await getSql();
    const items = await sql.query<OrderItemRow>(
      `select oi.id, oi.product_id, coalesce(p.name, oi.product_id) as product_name, p.image_path,
              oi.variant_id, oi.quantity, oi.unit_price::text, oi.currency, oi.product_total::text
         from order_items oi
         left join products p on p.id = oi.product_id
        where oi.order_id = $1
        order by oi.id`,
      [order.id],
    );
    // Delivery work is operational provider reporting, NOT authoritative proof
    // that a customer received the order or that money may be released.
    // Recheck customer ownership in this query even after requireCustomerOrder.
    const deliveryRows = await sql.query<{
      status:string; providerName:string; trackingUrl:string|null; updatedAt:string;
    }>(
      `select j.status,p.name as "providerName",j.tracking_url as "trackingUrl",
              j.updated_at::text as "updatedAt"
         from delivery_jobs j
         join delivery_providers p on p.id=j.provider_id
         join orders o on o.id=j.order_id
        where j.order_id=$1 and o.user_id=$2
        limit 1`, [order.id,userId],
    );
    return {
      order,
      delivery: deliveryRows[0] ?? null,
      items: items.map((row) => ({
        id: row.id,
        productId: row.product_id,
        productName: row.product_name,
        imagePath: row.image_path,
        variantId: row.variant_id,
        quantity: Number(row.quantity),
        unitPrice: row.unit_price,
        currency: row.currency,
        productTotal: row.product_total,
      })),
    };
  });

export const getMerchantOrder = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(merchantOrderSchema)
  .handler(async ({ data, context }) => {
    await requireMerchantOrAdminForUserId(context.userId);
    await requireMerchantAccessForUserId(data.merchantId, context.userId);
    getAuthenticatedUserId(context);
    const order = await requireMerchantOrder(data.orderId, data.merchantId);
    const sql = await getSql();
    const items = await sql.query<OrderItemRow>(
      `select oi.id, oi.product_id, coalesce(p.name, oi.product_id) as product_name, p.image_path,
              oi.variant_id, oi.quantity, oi.unit_price::text, oi.currency, oi.product_total::text
         from order_items oi
         left join products p on p.id = oi.product_id
        where oi.order_id = $1
        order by oi.id`,
      [order.id],
    );
    return {
      order,
      items: items.map((row) => ({
        id: row.id,
        productId: row.product_id,
        productName: row.product_name,
        imagePath: row.image_path,
        variantId: row.variant_id,
        quantity: Number(row.quantity),
        unitPrice: row.unit_price,
        currency: row.currency,
        productTotal: row.product_total,
      })),
    };
  });

export const cancelCustomerOrder = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(orderIdSchema)
  .handler(async ({ data, context }) => {
    await requireCustomerForUserId(context.userId);
    const userId = getAuthenticatedUserId(context);
    await enforceRateLimit("customer-order-cancel", { windowSeconds: 300, maxRequests: 5, subject: userId });
    await enforceRateLimit("customer-order-cancel-account", {identity:"subject", windowSeconds:300, maxRequests:8, subject:userId });
    await requireFreshSession();
    await requireCustomerOrder(data.orderId, userId);
    const sql = await getSql();
    const orderRows = await sql.query<{ id: string; status: string; payment_id: string | null }>(`select o.id,o.status,p.id as payment_id from orders o left join payments p on p.order_id=o.id where o.id=$1 and o.user_id=$2 limit 1`, [data.orderId, userId]);
    const order = orderRows[0];
    if (!order) throw new Error("Order not found");
    if (order.status === "payment_pending") {
      await sql.query(`with identity as (select set_config('app.user_id', $1, true)) select release_order_stock($2, $1) from identity`, [userId, data.orderId]);
      return { orderId: data.orderId, status: "cancelled" as const, refundStatus: "not_required" as const };
    }
    if (!['paid','confirmed','refund_pending'].includes(order.status)) {
      throw new Error("Order is no longer cancellable");
    }
    if (!order.payment_id) throw new Error("Paid order has no payment record");
    const refundRows = await sql.query<{ id: string; status: string; requested_by: string | null }>(`select id,status,requested_by from provider_refund_requests where payment_id=$1 and status in ('requested','processing','needs_attention','processed') order by requested_at desc limit 1`, [order.payment_id]);
    if (refundRows[0]?.requested_by && refundRows[0].requested_by !== userId) throw new Error("Refund request is not owned by this customer");
    let requestId = refundRows[0]?.id as string | undefined;
    if (!requestId) {
      const created = await sql.query<{ result: { requestId?: string } | null }>(`select prepare_provider_refund_for_payment($1,$2,$3) as result`, [order.payment_id, userId, "customer_order_cancellation"]);
      requestId = created[0]?.result?.requestId;
    }
    if (!requestId) throw new Error("Refund request could not be prepared");
    const { executeProviderRefundAsAuthenticatedUser } = await import("@/modules/payments/public/refunds.server");
    const refund = await executeProviderRefundAsAuthenticatedUser(requestId);
    return { orderId: data.orderId, status: "refund_pending" as const, refundStatus: refund.status as string };
  });

const customerDisputeSchema = z.object({
  orderId: z.string().min(1).max(128),
  reason: z.string().trim().min(8).max(2000),
});

export const openCustomerOrderDispute = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(customerDisputeSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireCustomerForUserId(userId);
    await enforceRateLimit("customer-order-dispute", { windowSeconds: 3600, maxRequests: 10, subject: userId });
    await enforceRateLimit("customer-order-dispute-account", {identity:"subject", windowSeconds:3600, maxRequests:16, subject:userId });
    await enforceRateLimit("customer-order-dispute-order", { windowSeconds: 3600, maxRequests: 2, subject: `${userId}:${data.orderId}` });
    const sql = await getSql();
    const rows = await sql.query<{ result: JsonObject }>(
      `select open_customer_order_dispute($1,$2,$3) as result`,
      [data.orderId, userId, data.reason],
    );
    if (!rows[0]?.result) throw new Error("Dispute could not be opened");
    return rows[0].result;
  });
