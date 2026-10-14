import { createFileRoute } from "@tanstack/react-router";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { authorizeScheduledJobRequest } from "@/lib/security/internal-job-auth.server";
import {
  reconcileStalePayments,
  reconcileProviderRefunds,
} from "@/modules/payments/public/reconciliation.server";

export const Route = createFileRoute("/api/internal/reconcile-payments")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (
          !(await authorizeScheduledJobRequest(
            request,
            process.env.CRON_SECRET,
            process.env.CRON_SECRET,
          ))
        ) {
          throw new Response("Unauthorized", {
            status: 401,
            headers: { "cache-control": "no-store" },
          });
        }
        await enforceRateLimit("internal-reconcile-payments", {
          windowSeconds: 60,
          maxRequests: 6,
        });
        // Bounded each invocation; the claim lease inside the sweep makes
        // overlapping cron invocations skip already-claimed payments.
        const summary = await reconcileStalePayments(50);
        const refunds = await reconcileProviderRefunds(50);
        return Response.json({ ...summary, refunds }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
