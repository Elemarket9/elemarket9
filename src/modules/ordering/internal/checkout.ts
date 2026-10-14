import { assertCommerceExecutionAllowed } from "@/lib/security/launch-profile.mjs";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";

const itemSchema = z.object({
  productId: z.string().min(1).max(64),
  variantId: z.string().min(1).max(64).nullable(),
  quantity: z.number().int().min(1).max(20),
});

const quoteSchema = z.object({
  merchantId: z.string().min(1).max(64),
  quoteId: z.string().min(1).max(64),
});

const pendingCheckoutSchema = z.object({
  idempotencyKey: z.string().min(16).max(128),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(itemSchema).min(1).max(40),
  quotes: z.array(quoteSchema).min(1).max(40),
  address: z.string().trim().min(8).max(400),
  method: z.enum(["mobile_money", "card", "bank_transfer"]),
  promoCode: z.string().trim().max(64).regex(/^[A-Za-z0-9_-]{4,64}$/).nullable().optional(),
  assistedDraftId: z.string().trim().min(1).max(80).nullable().optional(),
});

export type PendingCheckoutInput = z.infer<typeof pendingCheckoutSchema>;

const PAYMENT_METHODS = ["mobile_money", "card", "bank_transfer"] as const;
export type CheckoutPaymentMethod = (typeof PAYMENT_METHODS)[number];

export const listAvailableCheckoutPaymentMethods = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    if (process.env.ELEMARKET_LAUNCH_PROFILE === "developer_beta") return [];
    const [{ getSql }, { requireCustomerForUserId }] = await Promise.all([
      import("@/lib/db"),
      import("@/modules/identity/public/auth/authorization.server"),
    ]);
    await requireCustomerForUserId(getAuthenticatedUserId(context));
    const sql = await getSql();
    const rows = await sql.query<{ method: string }>(
      `select distinct method from payment_providers where status='active' and method = any($1::text[]) order by method`,
      [PAYMENT_METHODS],
    );
    const allowed = new Set<string>(PAYMENT_METHODS);
    return rows.map((row) => row.method).filter((method): method is CheckoutPaymentMethod => allowed.has(method));
  });

export async function createPendingCheckoutServer(data: PendingCheckoutInput, userId: string) {
  const [{ getSql }, { requireCustomerForUserId }, { enforceRateLimit }] = await Promise.all([
    import("@/lib/db"),
    import("@/modules/identity/public/auth/authorization.server"),
    import("@/lib/security/rate-limit.server"),
  ]);
  assertCommerceExecutionAllowed("checkout");
  await requireCustomerForUserId(userId);
  await enforceRateLimit("checkout-create", { windowSeconds: 60, maxRequests: 8, subject: userId });
  const sql = await getSql();
  // Limit stock-hold abuse across retries and concurrent requests at the DB boundary.
  // This is a preflight only; atomic enforcement still requires a DB transaction guard.
  const pending = await sql.query<{ count: string }>(
    `select count(*)::text as count from orders where user_id=$1 and status='payment_pending'`, [userId]
  );
  if (Number(pending[0]?.count ?? 0) >= 3) throw new Error("Too many unpaid orders. Complete or cancel an existing order.");
  // Set the verified session identity and invoke the DB transaction in one SQL
  // statement/connection. The client never controls app.user_id.
  const rows = await sql.query<{ result: unknown }>(
    `with identity as (select set_config('app.user_id', $1, true) as user_id)
     select create_pending_order($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8) as result
     from identity, (select set_config('app.assisted_draft_id', coalesce($9, ''), true)) draft`,
    [
      userId,
      data.idempotencyKey,
      data.fingerprint,
      JSON.stringify(data.items),
      JSON.stringify(data.quotes),
      data.address,
      data.method,
      data.promoCode ?? null,
      data.assistedDraftId ?? null,
    ],
  );
  return rows[0]?.result ?? null;
}

export const createPendingCheckout = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(pendingCheckoutSchema)
  .handler(async ({ data, context }) => {
    const { requireCustomerForUserId } = await import("@/modules/identity/public/auth/authorization.server");
    await requireCustomerForUserId(context.userId);
    return createPendingCheckoutServer(data, getAuthenticatedUserId(context));
  });

