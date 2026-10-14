import { createFileRoute } from "@tanstack/react-router";
import { deliverEnterpriseOrderOutbox } from "@/modules/merchants/public/enterprise-integration.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { authorizeScheduledJobRequest } from "@/lib/security/internal-job-auth.server";

async function run(request: Request) {
  if (!(await authorizeScheduledJobRequest(request, process.env.ELEMARKET_ENTERPRISE_SYNC_SECRET, process.env.CRON_SECRET))) {
    return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  }
  await enforceRateLimit("enterprise-order-outbox-global", { windowSeconds: 60, maxRequests: 30 });
  try { return Response.json({ ok:true, result:await deliverEnterpriseOrderOutbox(50) }, { headers: { "cache-control": "no-store" } }); }
  catch { return new Response("Enterprise order outbox processing failed", { status:500, headers: { "cache-control": "no-store" } }); }
}

export const Route = createFileRoute("/api/internal/enterprise-order-outbox")({
  server: { handlers: { GET: ({ request }) => run(request), POST: ({ request }) => run(request) as Promise<Response> } },
});
