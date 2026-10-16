import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";

export type PaymentStatus = "initiated" | "authorized" | "completed" | "failed" | "refunded";

const createIntentSchema = z.object({
  paymentId: z.string().min(1).max(128),
  providerKey: z.string().min(2).max(128).optional(),
});

export const createPaymentIntent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(createIntentSchema)
  .handler(async ({ data, context }) => {
    const [{ requireCustomerForUserId }, { enforceRateLimit }] = await Promise.all([
      import("@/modules/identity/public/auth/authorization.server"),
      import("@/lib/security/rate-limit.server"),
    ]);
    await requireCustomerForUserId(context.userId);
    const userId = getAuthenticatedUserId(context);
    await enforceRateLimit("payment-intent", { windowSeconds: 60, maxRequests: 12, subject: userId });
    await enforceRateLimit("payment-intent-account", { identity:"subject", windowSeconds:60, maxRequests:18, subject:userId });
    const { createExternalPaymentIntent } = await import("@/modules/payments/internal/payment.server");
    return createExternalPaymentIntent({ ...data, userId: userId });
  });

export const getCustomerPaymentStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ paymentId: z.string().min(1).max(128) }))
  .handler(async ({ data, context }) => {
    const [{ requireCustomerForUserId }, { enforceRateLimit }, { requireCustomerPayment }, { getSql }] = await Promise.all([
      import("@/modules/identity/public/auth/authorization.server"),
      import("@/lib/security/rate-limit.server"),
      import("@/modules/payments/internal/ownership.server"),
      import("@/lib/db"),
    ]);
    await requireCustomerForUserId(context.userId);
    const userId = getAuthenticatedUserId(context);
    await enforceRateLimit("payment-status", { windowSeconds: 60, maxRequests: 30, subject: userId });
    await enforceRateLimit("payment-status-account", { identity:"subject", windowSeconds:60, maxRequests:60, subject:userId });
    const owned = await requireCustomerPayment(data.paymentId, userId);
    const sqlForGroup = await getSql();
    const groupRows = await sqlForGroup.query<{ group_id: string }>(
      `select group_id from orders where id=$1 and user_id=$2`, [owned.order_id, userId],
    );
    return { paymentId: owned.id, orderId: owned.order_id, groupId: groupRows[0]?.group_id ?? null, status: owned.status, providerReference: owned.provider_key ? (await (async()=>{ const sql=await getSql(); const r=await sql.query<{provider_reference:string|null}>(`select provider_reference from payment_attempts where payment_id=$1 order by attempt_no desc limit 1`,[owned.id]); return r[0]?.provider_reference ?? null; })()) : null };
  });

export const completePreviewPayment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ paymentId: z.string().min(1).max(128) }))
  .handler(async ({ data, context }) => {
    const { requireCustomerForUserId } = await import("@/modules/identity/public/auth/authorization.server");
    await requireCustomerForUserId(context.userId);
    const userId = getAuthenticatedUserId(context);
    const { completePreviewPaymentServer } = await import("@/modules/payments/internal/payment.server");
    return completePreviewPaymentServer({ paymentId: data.paymentId, userId: userId });
  });
