import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import type { JsonObject } from "@/lib/db-types";

const SCOPE = "merchant_health:read";
const MODEL_VERSION = "merchant-health-v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export const Route = createFileRoute("/api/financing/merchants/$merchantId/health")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const merchantId = String(params.merchantId ?? "").trim();
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(merchantId)) return json({ error: "invalid_request" }, 400);

        await enforceRateLimit("merchant-health-provider-auth", { windowSeconds: 60, maxRequests: 30 });
        const authorization = request.headers.get("authorization") ?? "";
        const match = authorization.match(/^Bearer\s+(elemh_[A-Za-z0-9_-]{32,256})$/);
        if (!match) return json({ error: "unauthorized" }, 401);

        const tokenHash = hashToken(match[1]);
        const sql = await getSql();
        const access = await sql.query<{ provider_id: string; provider_name: string; scopes: string }>(
          `select a.provider_id, fp.name as provider_name, a.scopes::text as scopes
             from merchant_financing_provider_access a
             join financing_providers fp on fp.id=a.provider_id
            where a.token_hash=$1 and a.merchant_id=$2
              and a.revoked_at is null
              and (a.expires_at is null or a.expires_at > now())
              and fp.audience='merchant' and fp.status='active' and fp.marketplace_enabled=true and fp.marketplace_partner_status='active' and fp.security_review_status in ('passed','waived') and fp.integration_status='ready' and fp.commercial_status='active' and fp.customer_channel_enabled=true
            limit 1`,
          [tokenHash, merchantId],
        );
        if (!access[0]) return json({ error: "unauthorized" }, 401);
        await sql.query(`update merchant_financing_provider_access set last_used_at=now(),updated_at=now() where token_hash=$1 and merchant_id=$2`, [tokenHash, merchantId]);

        let scopes: unknown;
        try { scopes = JSON.parse(access[0].scopes); } catch { scopes = []; }
        if (!Array.isArray(scopes) || !scopes.includes(SCOPE)) return json({ error: "forbidden" }, 403);

        await enforceRateLimit("merchant-health-provider-api", {
          windowSeconds: 60,
          maxRequests: 30,
          subject: `${access[0].provider_id}:${merchantId}`,
        });
        await enforceRateLimit("merchant-health-provider-account", {
          identity: "subject", windowSeconds: 60, maxRequests: 45,
          subject: `${access[0].provider_id}:${merchantId}`,
        });

        const score = await sql.query<JsonObject>(
          `select score,band,model_version,methodology_version,components,calculated_at::text,
                  data_period_start::text,data_period_end::text,sample_size,freshness_status,fresh_until::text
             from merchant_scores where merchant_id=$1 limit 1`,
          [merchantId],
        );

        let row = score[0];
        if (!row || !row.fresh_until || Date.parse(String(row.fresh_until)) <= Date.now()) {
          const recalculated = await sql.query<{ result: JsonObject }>(
            `select recalculate_merchant_health_score($1) as result`,
            [merchantId],
          );
          const result = recalculated[0]?.result;
          if (!result || result.status !== "fresh") {
            await sql.query(
              `select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
              ["financing_provider.merchant_health.read", "merchant", merchantId, null, "system", null, "success", JSON.stringify({ providerId: access[0].provider_id, status: result?.status ?? "insufficient_data" })],
            );
            return json({
              status: result?.status ?? "insufficient_data",
              modelVersion: MODEL_VERSION,
              methodologyVersion: MODEL_VERSION,
              merchantId,
              dataPeriodStart: result?.dataPeriodStart ?? null,
              dataPeriodEnd: result?.dataPeriodEnd ?? null,
              sampleSize: result?.sampleSize ?? 0,
            });
          }
          row = result;
        }

        const calculatedAt = Date.parse(String(row.calculated_at ?? ""));
        const fresh = Number.isFinite(calculatedAt) && Date.now() - calculatedAt <= MAX_AGE_MS;
        await sql.query(
          `select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          ["financing_provider.merchant_health.read", "merchant", merchantId, null, "system", null, "success", JSON.stringify({ providerId: access[0].provider_id, fresh })],
        );

        // Deliberately excludes merchant/customer PII, raw order IDs, addresses and payment data.
        return json({
          status: fresh ? "fresh" : "stale",
          merchantId,
          score: row.score ?? null,
          healthBand: (() => { const n = Number(row.score); if (!Number.isFinite(n)) return null; if (n < 400) return "limited_history"; if (n < 550) return "developing"; if (n < 700) return "established"; if (n < 850) return "strong"; return "very_strong"; })(),
          modelVersion: row.model_version ?? MODEL_VERSION,
          methodologyVersion: row.methodology_version ?? MODEL_VERSION,
          components: row.components ?? {},
          sampleSize: row.sample_size ?? 0,
          calculatedAt: row.calculated_at ?? null,
          dataPeriodStart: row.data_period_start ?? null,
          dataPeriodEnd: row.data_period_end ?? null,
          freshUntil: row.fresh_until ?? null,
        });
      },
    },
  },
});
