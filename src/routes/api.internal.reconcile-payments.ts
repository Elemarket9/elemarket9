import { createFileRoute } from "@tanstack/react-router";
import { reconcileFinancingDeposits } from "@/modules/financing/public/financing-deposit.server";
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
          ))
        ) {
          throw new Response("Unauthorized", {
            status: 401,
            headers: { "cache-control": "no-store" },
          });
        }
        await enforceRateLimit("internal-reconcile-payments", {
          identity: "subject",
          subject: "authenticated-scheduler",
          windowSeconds: 60,
          maxRequests: 6,
        });
        // Bounded each invocation; the claim lease inside the sweep makes
        // overlapping cron invocations skip already-claimed payments.
        const summary = await reconcileStalePayments(50);
        const refunds = await reconcileProviderRefunds(50);
        const financingDeposits = await reconcileFinancingDeposits(25);
        return Response.json(
          { ...summary, refunds, financingDeposits },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
