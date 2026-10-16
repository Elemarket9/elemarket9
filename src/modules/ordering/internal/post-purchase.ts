import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireCustomerForUserId, requireMerchantAccessForUserId } from "@/modules/identity/public/auth/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const returnSchema = z.object({
  orderId: z.string().trim().min(1).max(128),
  orderItemId: z.coerce.number().int().positive(),
  reasonCode: z.enum(["changed_mind","wrong_item","damaged","defective","not_as_described","missing_parts","other"]),
  reason: z.string().trim().min(8).max(2000),
  quantity: z.coerce.number().int().min(1).max(20),
});

const reviewSchema = z.object({
  orderId: z.string().trim().min(1).max(128),
  productId: z.string().trim().min(1).max(128),
  rating: z.coerce.number().int().min(1).max(5),
  body: z.string().trim().min(8).max(1000),
});


export const requestOrderReturn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(returnSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireCustomerForUserId(userId);
    await enforceRateLimit("customer-return-request", { windowSeconds: 3600, maxRequests: 10, subject: userId });
    const sql = await getSql();
    const rows = await sql.query<{ result: unknown }>(
      `select request_order_return($1,$2,$3,$4,$5,$6) as result`,
      [data.orderId, data.orderItemId, userId, data.reasonCode, data.reason, data.quantity],
    );
    return rows[0]?.result ?? null;
  });

export const submitOrderItemReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(reviewSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireCustomerForUserId(userId);
    await enforceRateLimit("customer-review-submit", { windowSeconds: 3600, maxRequests: 10, subject: userId });
    const sql = await getSql();
    const rows = await sql.query<{ result: unknown }>(
      `select review_order_item($1,$2,$3,$4,$5) as result`,
      [data.orderId, data.productId, userId, data.rating, data.body],
    );
    return rows[0]?.result ?? null;
  });

export const getMerchantPerformance = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId: z.string().trim().min(1).max(128) }))
  .handler(async ({ data, context }) => {
    await requireMerchantAccessForUserId(data.merchantId, context.userId);
    const sql = await getSql();
    const rows = await sql.query<{ result: unknown }>(`select merchant_performance_snapshot($1) as result`, [data.merchantId]);
    return rows[0]?.result ?? null;
  });
