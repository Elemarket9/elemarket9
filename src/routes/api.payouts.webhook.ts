import { createFileRoute } from "@tanstack/react-router";
import { rateLimitResponse } from "@/lib/security/rate-limit.server";
import { readBodyWithLimit } from "@/lib/security/body.server";
import { logServerError } from "@/lib/observability/safe-error.mjs";

// Payout provider notifications. The signature selects the driver; the body only
// names the payout. Its final state is always re-read from the provider.
export const Route = createFileRoute("/api/payouts/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { enforceRateLimit } = await import("@/lib/security/rate-limit.server");
          await enforceRateLimit("payout-webhook-global", { windowSeconds: 60, maxRequests: 300 });
        } catch (error) {
          const limited = rateLimitResponse(error);
          if (limited) return limited;
          throw error;
        }
        let rawBody: string;
        try { rawBody = await readBodyWithLimit(request, 64 * 1024); }
        catch { return new Response("Payload too large", { status: 413 }); }
        const { handlePayoutWebhook, PayoutWebhookError } = await import("@/modules/wallet/public/wallet.server");
        try {
          const result = await handlePayoutWebhook({ rawBody, headers: request.headers });
          return Response.json({ ok: true, result }, { headers: { "cache-control": "no-store" } });
        } catch (error) {
          if (error instanceof PayoutWebhookError) {
            const message = error.status === 401 ? "Unauthorized" : error.status === 413 ? "Payload too large" : "Webhook rejected";
            return new Response(message, { status: error.status, headers: { "cache-control": "no-store" } });
          }
          logServerError("[payout-webhook] unhandled processing error", error);
          return new Response("Webhook temporarily unavailable", { status: 503, headers: { "cache-control": "no-store" } });
        }
      },
    },
  },
});
