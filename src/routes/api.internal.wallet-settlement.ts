import { createFileRoute } from "@tanstack/react-router";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { authorizeScheduledJobRequest } from "@/lib/security/internal-job-auth.server";

// Scheduled merchant wallet work: release matured funds, send requested
// payouts, and read back payouts the provider has not finished.
export const Route = createFileRoute("/api/internal/wallet-settlement")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await authorizeScheduledJobRequest(request, process.env.CRON_SECRET))) {
          return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
        }
        await enforceRateLimit("internal-wallet-settlement", { identity: "subject", subject: "authenticated-scheduler", windowSeconds: 60, maxRequests: 6 });
        const { runWalletSettlement } = await import("@/modules/wallet/public/wallet.server");
        let payoutsConfigured = true;
        try {
          const { activePayoutDriverKey } = await import("@/modules/wallet/public/wallet.server");
          activePayoutDriverKey();
        } catch {
          payoutsConfigured = false;
        }
        const result = await runWalletSettlement();
        return Response.json({ ok: true, payoutsConfigured, ...result }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
