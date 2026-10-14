import { createFileRoute } from "@tanstack/react-router";
import { authorizeScheduledJobRequest } from "@/lib/security/internal-job-auth.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { getIntelligenceSql } from "@/lib/db";

/** Schedule independently of enterprise synchronization. Protected by CRON_SECRET. */
export const Route = createFileRoute("/api/internal/refresh-eide")({
  server: { handlers: { GET: async ({ request }) => {
    if (!(await authorizeScheduledJobRequest(request, process.env.CRON_SECRET, process.env.CRON_SECRET)))
      return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
    await enforceRateLimit("internal-refresh-eide", { windowSeconds: 60, maxRequests: 2 });
    const sql = await getIntelligenceSql();
    const results: Record<string, number | string> = {};
    let degraded = false;
    for (const [name, query] of [
      ["quality", "select refresh_eide_merchant_quality_batch(20) as refreshed"],
      ["features", "select refresh_eide_features(500) as refreshed"],
      ["attribution", "select refresh_eide_attribution_outcomes(100) as refreshed"],
      ["pruned", "select prune_eide_events(2000) as refreshed"],
    ] as const) {
      try { const rows = await sql.query<Record<string, unknown>>(query); results[name] = Number(rows[0]?.refreshed ?? 0); }
      catch { degraded = true; results[name] = "failed"; }
    }
    return Response.json({ ok: !degraded, degraded, results }, { status: degraded ? 503 : 200, headers: { "cache-control": "no-store" } });
  } } },
});
