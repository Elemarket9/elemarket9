import { createFileRoute } from "@tanstack/react-router";
import { syncAllEnterpriseCatalogs } from "@/modules/merchants/public/enterprise-catalog.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { authorizeInternalHmacRequest } from "@/lib/security/internal-job-auth.server";

async function run(request: Request) {
  if (!(await authorizeInternalHmacRequest(request, process.env.ELEMARKET_ENTERPRISE_SYNC_SECRET, process.env.CRON_SECRET))) {
    return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  }
  await enforceRateLimit("enterprise-catalog-global-sync", { windowSeconds: 60, maxRequests: 2 });
  try {
    return Response.json({ ok: true, results: await syncAllEnterpriseCatalogs() }, { headers: { "cache-control": "no-store" } });
  } catch {
    return new Response("Enterprise catalog sync failed", { status: 500, headers: { "cache-control": "no-store" } });
  }
}

export const Route = createFileRoute("/api/enterprise/catalog/sync")({
  server: { handlers: { GET: ({ request }) => run(request), POST: ({ request }) => run(request) as Promise<Response> } },
});
