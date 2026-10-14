import { createFileRoute } from "@tanstack/react-router";
import { enqueueEnterpriseWebhookEvent } from "@/modules/merchants/public/enterprise-integration.server";
import { verifyEnterpriseWebhook } from "@/modules/merchants/public/enterprise-catalog.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { readBodyWithLimit } from "@/lib/security/body.server";

export const Route = createFileRoute("/api/enterprise/catalog/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const merchantId = url.searchParams.get("merchantId")?.trim();
        if (!merchantId) return new Response("Missing merchantId", { status: 400 });
        const declaredLength = request.headers.get("content-length");
        if (declaredLength && Number(declaredLength) > 2 * 1024 * 1024) return new Response("Payload too large", { status: 413 });
        await enforceRateLimit("enterprise-catalog-webhook-global", { windowSeconds: 60, maxRequests: 300 });
        let rawBody: string;
        try { rawBody = await readBodyWithLimit(request, 2 * 1024 * 1024); }
        catch { return new Response("Payload too large", { status: 413 }); }
        const signature = request.headers.get("x-elemarket-catalog-signature") ?? request.headers.get("x-signature");
        const timestamp = request.headers.get("x-elemarket-timestamp");
        if (!(await verifyEnterpriseWebhook({ merchantId, rawBody, signature, timestamp }))) return new Response("Invalid catalog webhook signature", { status: 401 });
        await enforceRateLimit(`enterprise-catalog-webhook:${merchantId}`, { windowSeconds: 60, maxRequests: 60 });
        let payload: unknown;
        try { payload = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400 }); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return new Response("Invalid webhook payload", { status: 400 });
        const record = payload as Record<string, unknown>;
        const eventId = request.headers.get("x-event-id")?.trim() || (typeof record.eventId === "string" ? record.eventId.trim() : null);
        const eventType = request.headers.get("x-event-type")?.trim() || (typeof record.eventType === "string" ? record.eventType.trim() : "catalog.changed");
        try {
          const result = await enqueueEnterpriseWebhookEvent({ merchantId, rawBody, eventId, eventType, payload });
          return Response.json({ ok: true, result }, { status: result.duplicate ? 200 : 202 });
        } catch {
          return new Response("Webhook temporarily unavailable", { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } });
        }
      },
    },
  },
});
