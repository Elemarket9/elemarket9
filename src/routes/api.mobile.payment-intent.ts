import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { auth } from "@/modules/identity/public/auth/server";
import { createExternalPaymentIntent } from "@/modules/payments/public/payment.server";
import { readBodyWithLimit } from "@/lib/security/body.server";
import { rateLimitResponse } from "@/lib/security/rate-limit.server";
import { requireCustomerForUserId } from "@/modules/identity/public/auth/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { assertSameSiteRequest } from "@/modules/identity/public/auth/isolation.server";

const schema = z.object({ paymentId: z.string().min(1).max(128) });

export const Route = createFileRoute("/api/mobile/payment-intent")({
  server: { handlers: { POST: async ({ request }) => {
    assertSameSiteRequest();
    const current = await auth.api.getSession({ headers: request.headers });
    if (!current?.user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
    await requireCustomerForUserId(current.user.id);
    try {
      await enforceRateLimit("customer-payment-intent", { windowSeconds: 60, maxRequests: 8, subject: current.user.id });
      await enforceRateLimit("customer-payment-intent-account", { identity:"subject", windowSeconds:60, maxRequests:12, subject:current.user.id });
    } catch (error) {
      const limited = rateLimitResponse(error);
      if (limited) return limited;
      throw error;
    }
    let raw: string;
    try { raw = await readBodyWithLimit(request, 8 * 1024); } catch { return Response.json({ error: "Request too large" }, { status: 413 }); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "Invalid payment request" }, { status: 400 });
    try {
      const result = await createExternalPaymentIntent({ paymentId: parsed.data.paymentId, userId: current.user.id });
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const limited = rateLimitResponse(error);
      if (limited) return limited;
      console.error("[mobile-payment-intent] failed", error);
      return Response.json({ error: "Payment could not be started" }, { status: 400, headers: { "cache-control": "no-store" } });
    }
  } } },
});
