import { createFileRoute } from "@tanstack/react-router";
import { syncAllEnterpriseCatalogs } from "@/modules/merchants/public/enterprise-catalog.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { authorizeScheduledJobRequest } from "@/lib/security/internal-job-auth.server";
import { getIntelligenceSql as getSql } from "@/lib/db";

async function assertCronAuthorization(request: Request): Promise<void> {
  if (!(await authorizeScheduledJobRequest(request, process.env.CRON_SECRET, process.env.CRON_SECRET))) {
    throw new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  }
}

export const Route = createFileRoute("/api/internal/sync-enterprise-catalogs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await assertCronAuthorization(request);
        await enforceRateLimit("internal-sync-enterprise-catalogs", { windowSeconds: 60, maxRequests: 2 });
        try {
          const results = await syncAllEnterpriseCatalogs();
          // Legacy maintenance is retained for compatibility; independent EIDE scheduling is available.
          // EIDE refresh is deliberately bounded and piggybacks on the existing neutral
          // catalog scheduler. Oldest feature rows are refreshed first, so the work
          // rotates across large catalogs without introducing a new infrastructure dependency.
          const sql = await getSql();
          let refreshed = 0;
          let degraded = false;
          // Each maintenance lane fails independently. A slow quality aggregate must not suppress
          // product refresh or retention cleanup, and none of them may fail the catalog sync.
          try { await sql.query<{ refreshed: number }>(`select refresh_eide_merchant_quality_batch(10) as refreshed`); } catch { degraded = true; }
          try {
            const featureRows = await sql.query<{ refreshed: number }>(`select refresh_eide_features(50) as refreshed`);
            refreshed = Number(featureRows[0]?.refreshed ?? 0);
          } catch { degraded = true; }
          try { await sql.query(`select refresh_eide_attribution_outcomes(50) as observed`); } catch { degraded = true; }
          try { await sql.query(`select prune_eide_events(2000) as pruned`); } catch { degraded = true; }
          const eide = { modelVersion: "eide-v11.3", refreshed, degraded };
          return Response.json({ ok: true, results, eide }, { headers: { "cache-control": "no-store" } });
        } catch {
          return new Response("Enterprise catalog scheduler failed", { status: 500, headers: { "cache-control": "no-store" } });
        }
      },
    },
  },
});
