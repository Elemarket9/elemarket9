import { createFileRoute } from "@tanstack/react-router";
import { readBodyWithLimit } from "@/lib/security/body.server";
import { getEmailWebhookAdapter } from "@/modules/identity/public/auth/email/webhook.server";
import type { EmailWebhookAdapter } from "@/modules/identity/public/auth/email/webhook.types";
import { enforceRateLimit, rateLimitResponse } from "@/lib/security/rate-limit.server";

export const Route = createFileRoute("/api/email/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let adapter: EmailWebhookAdapter;
        try { adapter = getEmailWebhookAdapter(); }
        catch { return new Response("Email webhook provider is not configured", { status: 404, headers: { "cache-control": "no-store" } }); }
        try { await enforceRateLimit("email-webhook", { windowSeconds: 60, maxRequests: 120 }); }
        catch (error) { const limited = rateLimitResponse(error); if (limited) return limited; throw error; }
        const contentLength = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(contentLength) && contentLength > 256_000) return new Response("Payload too large", { status: 413 });
        // content-length and rawBody.length are bounded inside readBodyWithLimit before any unbounded read.
        let rawBody: string;
        try { rawBody = await readBodyWithLimit(request, 512 * 1024); }
        catch { return new Response("Payload too large", { status: 413 }); }
        if (new TextEncoder().encode(rawBody).byteLength > 256_000) return new Response("Payload too large", { status: 413 });
        try {
          const result = await adapter.handle(rawBody, request.headers);
          return Response.json(result, { status: 200 });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Webhook rejected";
          const status = message.includes("signature") || message.includes("secret") ? 401 : 400;
          return new Response(status === 401 ? "Unauthorized" : "Webhook rejected", { status, headers: { "cache-control": "no-store" } });
        }
      },
    },
  },
});
