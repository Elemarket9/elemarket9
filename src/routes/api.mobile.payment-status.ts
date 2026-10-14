import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { auth } from "@/modules/identity/public/auth/server";
import { requireCustomerPayment } from "@/modules/payments/public/ownership.server";
import { requireCustomerForUserId } from "@/modules/identity/public/auth/authorization.server";
import { getSql } from "@/lib/db";
import { readBodyWithLimit } from "@/lib/security/body.server";
import { enforceRateLimit, rateLimitResponse } from "@/lib/security/rate-limit.server";
import { assertSameSiteRequest } from "@/modules/identity/public/auth/isolation.server";

const schema = z.object({ paymentId: z.string().min(1).max(128) });

export const Route = createFileRoute("/api/mobile/payment-status")({
  server: { handlers: { POST: async ({ request }) => {
    assertSameSiteRequest();
    const current = await auth.api.getSession({ headers: request.headers });
    if (!current?.user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
    try {
      await requireCustomerForUserId(current.user.id);
      await enforceRateLimit("customer-payment-status", { windowSeconds: 60, maxRequests: 30, subject: current.user.id });
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
      const payment = await requireCustomerPayment(parsed.data.paymentId, current.user.id);
      const sql = await getSql();
      const attempts = await sql.query<{ provider_reference: string | null }>(`select provider_reference from payment_attempts where payment_id=$1 order by attempt_no desc limit 1`, [payment.id]);
      return Response.json({ paymentId: payment.id, orderId: payment.order_id, status: payment.status, providerReference: attempts[0]?.provider_reference ?? null }, { headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ error: "Payment not found" }, { status: 404, headers: { "cache-control": "no-store" } });
    }
  } } },
});
