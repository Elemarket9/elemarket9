import { assertCommerceExecutionAllowed } from "@/lib/security/launch-profile.mjs";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import type { JsonObject } from "@/lib/db-types";

export type CustomerFinancingType = "bnpl" | "installment";
export type MerchantFinancingType = "merchant_cash_advance" | "line_of_credit" | "term_loan";
export type FinancingAudience = "customer" | "merchant";

export type CustomerFinancingStartResult = {
  applicationId: string;
  status: string;
  initialContributionAmount: string | number | null;
  remainingAmount: string | number | null;
  minimumInitialContributionPercent: string | number;
  planMode: string | null;
  integrationMode: string | null;
  redirectUrl: string | null;
  providerApprovalRequired: boolean;
  replayed: boolean;
};

export type MerchantFinancingStartResult = {
  applicationId: string;
  status: string;
  scoreSnapshot: string | number | null;
  replayed: boolean;
};
// Customer providers: audience = 'customer' and status = 'active' and product_type in ('bnpl','installment').
// Merchant providers: audience = 'merchant' and status = 'active' and product_type in ('merchant_cash_advance','line_of_credit','term_loan').

export type FinancingProvider = {
  id: string;
  providerKey: string;
  name: string;
  audience: FinancingAudience;
  productType: CustomerFinancingType | MerchantFinancingType;
  status: "active" | "inactive" | "review";
  planMode?: "provider_defined" | "layaway" | "credit";
  minimumInitialContributionPercent?: number;
  earlyPickupSupported?: boolean;
  integrationMode?: "api" | "partner_handoff" | "manual_review";
  providerLegalName?: string | null;
  termsUrl?: string | null;
  privacyUrl?: string | null;
  minimumApplicationAmount?: number | null;
  maximumApplicationAmount?: number | null;
  currency?: string;
};

/** Provider-led financing: ELEMARKET orchestrates the application; the provider underwrites and funds it. */
export function isProductFinanceEligible(price: number, min?: number | null, max?: number | null): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  if (min != null && (!Number.isFinite(min) || price < min)) return false;
  if (max != null && (!Number.isFinite(max) || price > max)) return false;
  return true;
}

export function merchantHealthBand(score: number): string {
  if (!Number.isFinite(score)) return "limited_history";
  if (score < 400) return "limited_history";
  if (score < 550) return "developing";
  if (score < 700) return "established";
  if (score < 850) return "strong";
  return "very_strong";
}

// Atomic DB contract: start_customer_financing_application performs
// `select amount::text,expires_at::text,used_at::text from customer_financing_quotes where id=$1 and user_id=$2 for update` and consumes only when `used_at is null`.
// It also returns `providerApprovalRequired: true`; ELEMARKET never makes the credit decision. Merchant Health freshness is governed by `fresh_until`.
const hasAtMostTwoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
const financingMoney = z.number().finite().positive().max(100_000_000).refine(hasAtMostTwoDecimals, "Amount must have at most two decimal places");

const customerApplicationSchema = z.object({
  providerId: z.string().min(1).max(128),
  quoteId: z.string().min(1).max(128),
  initialContributionAmount: financingMoney.optional(),
  orderGroupId: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(16).max(128),
});

// Retry safety is enforced by merchant_financing_applications.idempotency_key and the
// atomic start_merchant_financing_application database transition.
// Provider audience remains explicit: audience = 'merchant' and status = 'active' and product_type in ('merchant_cash_advance','line_of_credit','term_loan').
const merchantApplicationSchema = z.object({
  providerId: z.string().min(1).max(128),
  merchantId: z.string().min(1).max(128),
  requestedAmount: financingMoney,
  idempotencyKey: z.string().min(16).max(128),
});

export const listCustomerFinancingProviders = createServerFn({ method: "GET" })
  .handler(async () => {
    const { enforceRateLimit } = await import("@/lib/security/rate-limit.server");
    await enforceRateLimit("customer-financing-provider-list", { windowSeconds: 60, maxRequests: 30 });
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const rows = await sql.query<FinancingProvider>(
      `select id,provider_key as "providerKey",name,audience,product_type as "productType",status,plan_mode as "planMode",
              minimum_initial_contribution_percent::float8 as "minimumInitialContributionPercent",early_pickup_supported as "earlyPickupSupported",
              integration_mode as "integrationMode",provider_legal_name as "providerLegalName",terms_url as "termsUrl",privacy_url as "privacyUrl",
              minimum_application_amount::float8 as "minimumApplicationAmount",maximum_application_amount::float8 as "maximumApplicationAmount",currency
         from financing_providers
        where audience='customer' and status='active' and marketplace_enabled=true
          and marketplace_partner_status='active' and security_review_status in ('passed','waived') and integration_status='ready' and commercial_status='active' and customer_channel_enabled=true and product_type in ('bnpl','installment')
        order by name`,
    );
    const { isFinancingIntegrationOperational } = await import("@/modules/financing/internal/adapters/financing-registry.server");
    return rows.filter((provider) => isFinancingIntegrationOperational({ providerKey: provider.providerKey, integrationMode: provider.integrationMode, audience: "customer" }));
  });


const financingPreviewSchema = z.object({
  items: z.array(z.object({
    productId: z.string().min(1).max(64),
    variantId: z.string().min(1).max(64).nullable().optional(),
    quantity: z.number().int().min(1).max(20),
  })).min(1).max(40),
  quoteIds: z.array(z.string().min(1).max(64)).min(1).max(40),
});

export const previewCustomerFinancing = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(financingPreviewSchema)
  .handler(async ({ data, context }) => {
    const [{ requireCustomerForUserId }, { enforceRateLimit }, { getSql }] = await Promise.all([
      import("@/modules/identity/public/auth/authorization.server"),
      import("@/lib/security/rate-limit.server"),
      import("@/lib/db"),
    ]);
    await requireCustomerForUserId(context.userId);
    const userId = getAuthenticatedUserId(context);
    await enforceRateLimit("customer-financing-preview", { windowSeconds: 60, maxRequests: 10, subject: userId });
    const sql = await getSql();
    const fingerprint = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify({ items: data.items, quoteIds: [...data.quoteIds].sort(), userId }))
    );
    const fingerprintHex = Array.from(new Uint8Array(fingerprint), (b) => b.toString(16).padStart(2, "0")).join("");

    const quotes = await sql.query<{ id: string; price: string; merchant_id: string; expires_at: string }>(
      `select id,price::text,merchant_id,expires_at::text from delivery_quotes where user_id=$1 and id = any($2::text[])`,
      [userId, data.quoteIds],
    );
    if (quotes.length !== data.quoteIds.length || quotes.some((q) => Date.parse(q.expires_at) <= Date.now())) {
      throw new Error("Financing quote expired");
    }

    let amount = quotes.reduce((sum, q) => sum + Number(q.price), 0);
    const seen = new Map<string, number>();
    const quoteMerchantIds = new Set(quotes.map((q) => q.merchant_id));
    const cartMerchantIds = new Set<string>();
    for (const item of data.items) {
      const key = `${item.productId}:${item.variantId ?? ""}`;
      seen.set(key, (seen.get(key) ?? 0) + item.quantity);
    }
    for (const [key, quantity] of seen) {
      const [productId, variantId] = key.split(":");
      const product = await sql.query<{ price: string; merchant_id: string; stock: number; financing_eligible: boolean }>(
        `select price::text,merchant_id,stock,financing_eligible from products where id=$1 and status='active'`, [productId],
      );
      if (!product[0] || !product[0].financing_eligible || Number(product[0].stock) < quantity) throw new Error("Financing is not available for this cart");
      cartMerchantIds.add(product[0].merchant_id);
      let unitPrice = Number(product[0].price);
      if (variantId) {
        const variant = await sql.query<{ price: string; stock: number }>(
          `select price::text,stock from product_variants where id=$1 and product_id=$2 and status='active'`, [variantId, productId],
        );
        if (!variant[0] || Number(variant[0].stock) < quantity) throw new Error("Financing is not available for this cart");
        unitPrice = Number(variant[0].price);
      }
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new Error("Financing is not available for this cart");
      amount += unitPrice * quantity;
    }
    if (quoteMerchantIds.size !== cartMerchantIds.size || [...cartMerchantIds].some((merchantId) => !quoteMerchantIds.has(merchantId))) {
      throw new Error("Financing delivery quotes do not match the cart merchants");
    }

    // Stable checkout-financing identity: authenticated customer + normalized cart +
    // resolved merchants. Delivery quote IDs are intentionally excluded because
    // refreshing delivery pricing must not create a new financing intent.
    const normalizedIntentItems = [...seen.entries()]
      .map(([key, quantity]) => ({ key, quantity }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const intentDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify({
        userId,
        items: normalizedIntentItems,
        merchantIds: [...cartMerchantIds].sort(),
      })),
    );
    const checkoutIntentId = Array.from(new Uint8Array(intentDigest), (b) => b.toString(16).padStart(2, "0")).join("");

    amount = Number(amount.toFixed(2));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Financing is not available for this cart");

    const quoteId = `cfq_${crypto.randomUUID().replaceAll("-", "")}`;
    await sql.query(
      `insert into customer_financing_quotes(id,user_id,amount,currency,cart_fingerprint,checkout_intent_id,checkout_intent_version,expires_at)
       values($1,$2,$3,'GHS',$4,$5,2,now()+interval '15 minutes')`,
      [quoteId, userId, amount, fingerprintHex, checkoutIntentId],
    );
    const providerRows = await sql.query<FinancingProvider>(
      `select id,provider_key as "providerKey",name,audience,product_type as "productType",status,plan_mode as "planMode",
              minimum_initial_contribution_percent::float8 as "minimumInitialContributionPercent",early_pickup_supported as "earlyPickupSupported",
              integration_mode as "integrationMode",provider_legal_name as "providerLegalName",terms_url as "termsUrl",privacy_url as "privacyUrl",
              minimum_application_amount::float8 as "minimumApplicationAmount",maximum_application_amount::float8 as "maximumApplicationAmount",currency
         from financing_providers
        where audience='customer' and status='active' and marketplace_enabled=true and marketplace_partner_status='active' and security_review_status in ('passed','waived') and integration_status='ready' and commercial_status='active' and customer_channel_enabled=true
          and product_type in ('bnpl','installment') and currency='GHS'
          and (minimum_application_amount is null or minimum_application_amount <= $1)
          and (maximum_application_amount is null or maximum_application_amount >= $1)
        order by name`, [amount],
    );
    const { isFinancingIntegrationOperational } = await import("@/modules/financing/internal/adapters/financing-registry.server");
    const providers = providerRows.filter((provider) => isFinancingIntegrationOperational({ providerKey: provider.providerKey, integrationMode: provider.integrationMode, audience: "customer" }));
    return { quoteId, amount, currency: "GHS" as const, expiresAt: new Date(Date.now()+15*60*1000).toISOString(), providers };
  });

export const startCustomerFinancing = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(customerApplicationSchema)
  .handler(async ({ data, context }) => {
    assertCommerceExecutionAllowed("startCustomerFinancing");
    const [{ requireCustomerForUserId }, { enforceRateLimit }, { getSql }] = await Promise.all([
      import("@/modules/identity/public/auth/authorization.server"),
      import("@/lib/security/rate-limit.server"),
      import("@/lib/db"),
    ]);
    await requireCustomerForUserId(context.userId);
    const userId = getAuthenticatedUserId(context);
    await enforceRateLimit("customer-financing-start", { windowSeconds: 3600, maxRequests: 5, subject: userId });
    const sql = await getSql();
    const providerRows = await sql.query<{ providerKey:string; integrationMode:string }>(
      `select provider_key as "providerKey",integration_mode as "integrationMode" from financing_providers
        where id=$1 and audience='customer' and status='active' and marketplace_enabled=true and marketplace_partner_status='active' and security_review_status in ('passed','waived') and integration_status='ready' and commercial_status='active' and customer_channel_enabled=true`, [data.providerId],
    );
    const provider = providerRows[0];
    if (!provider) throw new Error("Financing provider unavailable");
    const activeForms = await sql.query<{ id: string }>(
      `select id from financing_provider_forms where provider_id=$1 and status='active' limit 1`,
      [data.providerId],
    );
    if (activeForms.length) throw new Error("This financing provider requires its checkout application form");
    const { isFinancingIntegrationOperational } = await import("@/modules/financing/internal/adapters/financing-registry.server");
    if (!isFinancingIntegrationOperational({ providerKey: provider.providerKey, integrationMode: provider.integrationMode, audience: "customer" })) throw new Error("Financing provider integration is not configured");
    const rows = await sql.query<{ result: JsonObject }>(
      `select start_customer_financing_application($1,$2,$3,$4,$5,$6) as result`,
      [userId, data.providerId, data.quoteId, data.orderGroupId ?? null, data.initialContributionAmount ?? null, data.idempotencyKey],
    );
    const result = rows[0]?.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Financing application could not be started");
    if (typeof result.applicationId !== "string" || typeof result.status !== "string" || typeof result.providerApprovalRequired !== "boolean" || typeof result.replayed !== "boolean") {
      throw new Error("Financing application returned an invalid result");
    }
    return {
      applicationId: result.applicationId, status: result.status,
      initialContributionAmount: typeof result.initialContributionAmount === "string" || typeof result.initialContributionAmount === "number" || result.initialContributionAmount === null ? result.initialContributionAmount : null,
      remainingAmount: typeof result.remainingAmount === "string" || typeof result.remainingAmount === "number" || result.remainingAmount === null ? result.remainingAmount : null,
      minimumInitialContributionPercent: typeof result.minimumInitialContributionPercent === "string" || typeof result.minimumInitialContributionPercent === "number" ? result.minimumInitialContributionPercent : 0,
      planMode: typeof result.planMode === "string" ? result.planMode : null,
      integrationMode: typeof result.integrationMode === "string" ? result.integrationMode : null,
      redirectUrl: typeof result.redirectUrl === "string" ? result.redirectUrl : null,
      providerApprovalRequired: result.providerApprovalRequired, replayed: result.replayed,
    } satisfies CustomerFinancingStartResult;
  });

export const listMerchantFinancingProviders = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId: z.string().min(1).max(128) }))
  .handler(async ({ data, context }) => {
    const { requireMerchantAccessForUserId } = await import("@/modules/identity/public/auth/authorization.server");
    await requireMerchantAccessForUserId(data.merchantId, context.userId);
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const rows = await sql.query<FinancingProvider>(
      `select id,provider_key as "providerKey",name,audience,product_type as "productType",status,plan_mode as "planMode",integration_mode as "integrationMode",
              provider_legal_name as "providerLegalName",terms_url as "termsUrl",privacy_url as "privacyUrl",
              minimum_application_amount::float8 as "minimumApplicationAmount",maximum_application_amount::float8 as "maximumApplicationAmount",currency
         from financing_providers where audience='merchant' and status='active' and marketplace_enabled=true
          and marketplace_partner_status='active' and security_review_status in ('passed','waived') and integration_status='ready' and commercial_status='active' and customer_channel_enabled=true and product_type in ('merchant_cash_advance','line_of_credit','term_loan') order by name`,
    );
    const { isFinancingIntegrationOperational } = await import("@/modules/financing/internal/adapters/financing-registry.server");
    return rows.filter((provider) => isFinancingIntegrationOperational({ providerKey: provider.providerKey, integrationMode: provider.integrationMode, audience: "merchant" }));
  });

// Merchant Health is refreshed by recalculate_merchant_health_score inside the atomic merchant financing transition.
export const startMerchantFinancing = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(merchantApplicationSchema)
  .handler(async ({ data, context }) => {
    assertCommerceExecutionAllowed("startMerchantFinancing");
    const [{ requireMerchantOrAdminForUserId, requireMerchantAccessForUserId }, { enforceRateLimit }, { getSql }] = await Promise.all([
      import("@/modules/identity/public/auth/authorization.server"),
      import("@/lib/security/rate-limit.server"),
      import("@/lib/db"),
    ]);
    await requireMerchantOrAdminForUserId(context.userId);
    await requireMerchantAccessForUserId(data.merchantId, context.userId);
    const userId = getAuthenticatedUserId(context);
    await enforceRateLimit("merchant-financing-start", { windowSeconds: 3600, maxRequests: 5, subject: userId });
    const sql = await getSql();
    const providerRows = await sql.query<{ providerKey:string; integrationMode:string }>(
      `select provider_key as "providerKey",integration_mode as "integrationMode" from financing_providers
        where id=$1 and audience='merchant' and status='active' and marketplace_enabled=true and marketplace_partner_status='active' and security_review_status in ('passed','waived') and integration_status='ready' and commercial_status='active' and customer_channel_enabled=true
          and currency='GHS' and (minimum_application_amount is null or minimum_application_amount <= $2)
          and (maximum_application_amount is null or maximum_application_amount >= $2)`, [data.providerId,data.requestedAmount],
    );
    const provider = providerRows[0];
    if (!provider) throw new Error("Merchant financing provider unavailable");
    const { isFinancingIntegrationOperational } = await import("@/modules/financing/internal/adapters/financing-registry.server");
    if (!isFinancingIntegrationOperational({ providerKey: provider.providerKey, integrationMode: provider.integrationMode, audience: "merchant" })) throw new Error("Merchant financing provider integration is not configured");
    const rows = await sql.query<{ result: JsonObject }>(
      `select start_merchant_financing_application($1,$2,$3,$4) as result`,
      [data.merchantId, data.providerId, data.requestedAmount, data.idempotencyKey],
    );
    const result = rows[0]?.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Merchant financing application could not be started");
    if (typeof result.applicationId !== "string" || typeof result.status !== "string" || typeof result.replayed !== "boolean") {
      throw new Error("Merchant financing application returned an invalid result");
    }
    return {
      applicationId: result.applicationId, status: result.status,
      scoreSnapshot: typeof result.scoreSnapshot === "string" || typeof result.scoreSnapshot === "number" || result.scoreSnapshot === null ? result.scoreSnapshot : null,
      replayed: result.replayed,
    } satisfies MerchantFinancingStartResult;
  });

export const getCustomerFinancingApplication = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ applicationId: z.string().min(1).max(128) }))
  .handler(async ({ data, context }) => {
    const [{ requireCustomerForUserId }, { requireCustomerFinancingApplication }] = await Promise.all([
      import("@/modules/identity/public/auth/authorization.server"),
      import("@/modules/financing/internal/ownership.server"),
    ]);
    await requireCustomerForUserId(context.userId);
    const userId = getAuthenticatedUserId(context);
    return requireCustomerFinancingApplication(data.applicationId, userId);
  });

export const getMerchantFinancingApplication = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ applicationId: z.string().min(1).max(128), merchantId: z.string().min(1).max(128) }))
  .handler(async ({ data, context }) => {
    const { requireMerchantOrAdminForUserId, requireMerchantAccessForUserId } = await import("@/modules/identity/public/auth/authorization.server");
    const { requireMerchantFinancingApplication } = await import("@/modules/financing/internal/ownership.server");
    await requireMerchantOrAdminForUserId(context.userId);
    await requireMerchantAccessForUserId(data.merchantId, context.userId);
    return requireMerchantFinancingApplication(data.applicationId, data.merchantId);
  });
