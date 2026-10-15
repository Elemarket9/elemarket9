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
  promoCode: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9_-]{4,64}$/)
    .nullable()
    .optional(),
  assistedDraftId: z.string().trim().min(1).max(80).nullable().optional(),
});

export type PendingCheckoutInput = z.infer<typeof pendingCheckoutSchema>;

const PAYMENT_METHODS = ["mobile_money", "card", "bank_transfer"] as const;
export type CheckoutPaymentMethod = (typeof PAYMENT_METHODS)[number];

async function availableCheckoutPaymentMethods() {
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const rows = await sql.query<{
    method: string;
    provider_key: string;
    driver_key: string | null;
    requires_merchant_account: boolean;
  }>(
    `select distinct on (method) method, provider_key, driver_key, requires_merchant_account from payment_providers where status='active' and method = any($1::text[]) order by method, provider_key`,
    [PAYMENT_METHODS],
  );
  const allowed = new Set<string>(PAYMENT_METHODS);
  const { getPaymentAdapter, assertPaymentInitializationReady } =
    await import("@/modules/payments/public/adapters/registry");
  const available = new Set<CheckoutPaymentMethod>();
  for (const row of rows) {
    if (!allowed.has(row.method)) continue;
    try {
      const adapter = await getPaymentAdapter(row.provider_key, row.driver_key ?? undefined);
      assertPaymentInitializationReady(adapter, row.provider_key);
      if (row.requires_merchant_account && adapter.supportsDirectSubaccountSettlement !== true)
        continue;
      available.add(row.method as CheckoutPaymentMethod);
    } catch {
      // Match the provider selected by the SQL checkout; do not advertise
      // a different adapter that the order transaction would never use.
    }
  }
  return [...available];
}

export const listAvailableCheckoutPaymentMethods = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { requireCustomerForUserId } =
      await import("@/modules/identity/public/auth/authorization.server");
    await requireCustomerForUserId(getAuthenticatedUserId(context));
    return availableCheckoutPaymentMethods();
  });

export async function createPendingCheckoutServer(data: PendingCheckoutInput, userId: string) {
  const [{ getSql }, { requireCustomerForUserId }, { enforceRateLimit }] = await Promise.all([
    import("@/lib/db"),
    import("@/modules/identity/public/auth/authorization.server"),
    import("@/lib/security/rate-limit.server"),
  ]);
  await requireCustomerForUserId(userId);
  await enforceRateLimit("checkout-create", { windowSeconds: 60, maxRequests: 8, subject: userId });
  if (!(await availableCheckoutPaymentMethods()).includes(data.method)) {
    throw new Error("The selected payment method has no configured, enabled payment provider.");
  }
  const sql = await getSql();
  // The database enforces reservation quotas under the customer advisory lock,
  // after resolving idempotency. A separate count would reject safe retries.
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
  const result = rows[0]?.result;
  if (
    !result ||
    typeof result !== "object" ||
    !("groupId" in result) ||
    typeof result.groupId !== "string"
  )
    throw new Error("Checkout transaction did not return an order group");
  // The SQL idempotency replay returns a smaller shape. Always read the same
  // owned, authoritative totals so a retry can render the final review too.
  const orders = await sql.query<{
    orderId: string;
    merchantId: string;
    paymentId: string;
    status: string;
    grandTotal: string;
    productTotal: string;
    deliveryTotal: string;
    promoDiscount: string;
  }>(
    `select o.id as "orderId", o.merchant_id as "merchantId", p.id as "paymentId", o.status,
            o.grand_total::text as "grandTotal", o.product_total::text as "productTotal",
            o.delivery_total::text as "deliveryTotal", o.promo_discount::text as "promoDiscount"
       from orders o join payments p on p.order_id=o.id and p.user_id=$2
      where o.group_id=$1 and o.user_id=$2 order by o.id`,
    [result.groupId, userId],
  );
  if (!orders.length) throw new Error("Checkout group has no owned payable orders");
  return { groupId: result.groupId, replay: "replay" in result && result.replay === true, orders };
}

export const createPendingCheckout = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(pendingCheckoutSchema)
  .handler(async ({ data, context }) => {
    const { requireCustomerForUserId } =
      await import("@/modules/identity/public/auth/authorization.server");
    await requireCustomerForUserId(context.userId);
    return createPendingCheckoutServer(data, getAuthenticatedUserId(context));
  });
