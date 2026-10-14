import { createFileRoute } from "@tanstack/react-router";
import { handlePaymentWebhook } from "@/application/payment-webhook.server";
import { rateLimitResponse } from "@/lib/security/rate-limit.server";
import { readBodyWithLimit } from "@/lib/security/body.server";
import { PaymentWebhookError } from "@/modules/payments/public/payment-errors";

export const Route = createFileRoute("/api/payments/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        // Provider selection is only a candidate hint. The payment layer resolves the
        // actual provider cryptographically from the webhook signature and rejects
        // ambiguous/no-match signatures. Never trust a client-supplied provider as
        // authoritative routing information.
        const providerHint = request.headers.get("x-elemarket-provider") ?? url.searchParams.get("provider") ?? undefined;
        try {
          const { enforceRateLimit } = await import("@/lib/security/rate-limit.server");
          await enforceRateLimit("payment-webhook-global", { windowSeconds: 60, maxRequests: 600 });
        } catch (error) {
          const limited = rateLimitResponse(error);
          if (limited) return limited;
          throw error;
        }
        // content-length and rawBody.length are bounded inside readBodyWithLimit before any unbounded read.
        let rawBody: string;
        try { rawBody = await readBodyWithLimit(request, 1024 * 1024); }
        catch { return new Response("Payload too large", { status: 413 }); }
        try {
          const result = await handlePaymentWebhook({ providerKey: providerHint, rawBody, headers: request.headers });
          return Response.json({ ok: true, result });
        } catch (error) {
          const limited = rateLimitResponse(error);
          if (limited) return limited;
          if (error instanceof PaymentWebhookError) {
            const publicMessage = error.status === 401 ? "Unauthorized" : error.status === 413 ? "Payload too large" : error.status >= 500 ? "Webhook temporarily unavailable" : "Webhook rejected";
            return new Response(publicMessage, { status: error.status, headers: { "cache-control": "no-store" } });
          }
          // PostgreSQL exposes transient failures through SQLSTATE, not message text.
          const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
          if (/^(08|40P01|40001|53300|57P01)/.test(code)) {
            return new Response("Webhook temporarily unavailable", { status: 503, headers: { "cache-control": "no-store" } });
          }
          console.error("[payment-webhook] unhandled processing error", error);
          return new Response("Webhook processing failed", { status: 500, headers: { "cache-control": "no-store" } });
        }
      },
    },
  },
});
