import { createHash, randomBytes } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireMerchantAccessForUserId, requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import type { JsonObject } from "@/lib/db-types";

export const MERCHANT_HEALTH_MODEL_VERSION = "merchant-health-v1";
export const MERCHANT_HEALTH_SCOPE = "merchant_health:read";

const merchantIdSchema = z.string().trim().min(1).max(128);

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newProviderAccessToken(): string {
  return `elemh_${randomBytes(32).toString("base64url")}`;
}

/** Recalculate only from verified marketplace records; never accepts score inputs from clients. */
export const recalculateMerchantHealthScore = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId: merchantIdSchema }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireAdminForUserId(userId);
    await enforceRateLimit("merchant-health-recalculate", { windowSeconds: 3600, maxRequests: 120, subject: userId });
    const sql = await getSql();
    const rows = await sql.query<{ result: JsonObject }>(
      `select recalculate_merchant_health_score($1) as result`,
      [data.merchantId],
    );
    return rows[0]?.result ?? { status: "insufficient_data", merchantId: data.merchantId };
  });

/** Merchant-consented, provider-specific access grant. The raw token is returned once and never stored. */
export const createMerchantHealthProviderAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    merchantId: merchantIdSchema,
    providerId: z.string().trim().min(1).max(128),
    expiresAt: z.string().datetime().optional(),
  }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireMerchantAccessForUserId(data.merchantId, userId);
    await requireFreshSession();
    await enforceRateLimit("merchant-health-provider-grant", { windowSeconds: 3600, maxRequests: 10, subject: userId });
    const sql = await getSql();
    const provider = await sql.query<{ id: string }>(
      `select id from financing_providers where id=$1 and audience='merchant' and status='active' and marketplace_enabled=true and marketplace_partner_status='active' and security_review_status in ('passed','waived') and integration_status='ready' and commercial_status='active' and customer_channel_enabled=true limit 1`,
      [data.providerId],
    );
    if (!provider[0]) throw new Error("Financing provider unavailable");
    const expiresAt = data.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const expiryMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) throw new Error("Access expiry must be in the future");
    if (expiryMs > Date.now() + 90 * 24 * 60 * 60 * 1000) throw new Error("Provider access may not exceed 90 days");

    // One active grant per provider/merchant prevents stale credentials accumulating.
    await sql.query(
      `update merchant_financing_provider_access
          set revoked_at=now(),updated_at=now()
        where merchant_id=$1 and provider_id=$2 and revoked_at is null`,
      [data.merchantId, data.providerId],
    );

    const token = newProviderAccessToken();
    const hash = hashToken(token);
    const id = `mhpa_${randomBytes(12).toString("hex")}`;
    await sql.query(
      `insert into merchant_financing_provider_access
        (id,provider_id,merchant_id,token_hash,token_prefix,scopes,expires_at,created_by_user_id)
       values($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [id, data.providerId, data.merchantId, hash, token.slice(0, 16), JSON.stringify([MERCHANT_HEALTH_SCOPE]), expiresAt, userId],
    );
    return { accessId: id, providerId: data.providerId, merchantId: data.merchantId, scope: MERCHANT_HEALTH_SCOPE, token, expiresAt };
  });

export const revokeMerchantHealthProviderAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId: merchantIdSchema, accessId: z.string().min(1).max(128) }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireMerchantAccessForUserId(data.merchantId, userId);
    await requireFreshSession();
    await enforceRateLimit("merchant-health-provider-revoke", { windowSeconds: 3600, maxRequests: 20, subject: userId });
    const sql = await getSql();
    const rows = await sql.query<{ id: string }>(
      `update merchant_financing_provider_access set revoked_at=now(),updated_at=now()
        where id=$1 and merchant_id=$2 and revoked_at is null returning id`,
      [data.accessId, data.merchantId],
    );
    if (!rows[0]) throw new Error("Access grant not found");
    return { revoked: true };
  });


export const listMerchantHealthProviders = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId: merchantIdSchema }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireMerchantAccessForUserId(data.merchantId, userId);
    const sql = await getSql();
    return sql.query<{ id: string; name: string; productType: string; accessId: string | null; expiresAt: string | null }>(
      `select fp.id,fp.name,fp.product_type as "productType",a.id as "accessId",a.expires_at::text as "expiresAt"
         from financing_providers fp
         left join merchant_financing_provider_access a
           on a.provider_id=fp.id and a.merchant_id=$1 and a.revoked_at is null
        where fp.audience='merchant' and fp.status='active' and fp.marketplace_enabled=true and fp.marketplace_partner_status='active' and fp.security_review_status in ('passed','waived') and fp.integration_status='ready' and fp.commercial_status='active' and fp.customer_channel_enabled=true
        order by fp.name`,
      [data.merchantId],
    );
  });

export const getMerchantHealthForMerchant = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId: merchantIdSchema }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireMerchantAccessForUserId(data.merchantId, userId);
    const sql = await getSql();
    const rows = await sql.query<{ score: number | string | null; band: string | null; model_version: string; methodology_version: string; components: JsonObject; calculated_at: string | null; data_period_start: string | null; data_period_end: string | null; sample_size: number; freshness_status: string; fresh_until: string | null }>(
      `select score,band,model_version,methodology_version,components,calculated_at::text,
              data_period_start::text,data_period_end::text,sample_size,case when fresh_until is not null and fresh_until <= now() then 'stale' else freshness_status end as freshness_status,fresh_until::text
         from merchant_scores where merchant_id=$1 limit 1`,
      [data.merchantId],
    );
    if (!rows[0]) return { status: "insufficient_data", modelVersion: MERCHANT_HEALTH_MODEL_VERSION };
    return { status: rows[0].freshness_status === "fresh" && (!rows[0].fresh_until || Date.parse(String(rows[0].fresh_until)) > Date.now()) ? "fresh" : "stale", ...rows[0] };
  });
