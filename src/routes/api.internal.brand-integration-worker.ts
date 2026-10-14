import { createFileRoute } from "@tanstack/react-router";
import { processBrandIntegrationOrderOutbox, processBrandIntegrationWebhooks } from "@/modules/merchants/public/brand-integration.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { authorizeInternalHmacRequest } from "@/lib/security/internal-job-auth.server";

export const Route = createFileRoute("/api/internal/brand-integration-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await authorizeInternalHmacRequest(
          request,
          process.env.ELEMARKET_ENTERPRISE_SYNC_SECRET,
          process.env.CRON_SECRET,
        ))) {
          return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
        }
        await enforceRateLimit("brand-integration-worker-global", { identity: "subject", subject: "authenticated-scheduler", windowSeconds: 60, maxRequests: 30 });
        const [webhooks, orders] = await Promise.all([
          processBrandIntegrationWebhooks(50),
          processBrandIntegrationOrderOutbox(50),
        ]);
        return Response.json({ ok: true, webhooks, orders }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
