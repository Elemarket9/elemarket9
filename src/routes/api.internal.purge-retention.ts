import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { authorizeScheduledJobRequest } from "@/lib/security/internal-job-auth.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { logServerError } from "@/lib/observability/safe-error.mjs";

/** Bounded operational retention. Financial and audit tables are not purged. */
export const Route = createFileRoute("/api/internal/purge-retention")({
  server: { handlers: { GET: async ({ request }) => {
    if (!(await authorizeScheduledJobRequest(request, process.env.CRON_SECRET)))
      return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
    await enforceRateLimit("internal-purge-retention", { identity: "subject", subject: "authenticated-scheduler", windowSeconds: 60, maxRequests: 4 });
    try {
      const sql = await getSql();
      const rows = await sql.query<{ result: Record<string, number> }>(`select purge_operational_retention_data() as result`);
      return Response.json({ ok: true, purged: rows[0]?.result ?? {} }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      logServerError("[purge-retention] failed", error);
      return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  } } },
});
