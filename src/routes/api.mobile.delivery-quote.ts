import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { auth } from "@/modules/identity/public/auth/server";
import { requestDeliveryQuoteServer } from "@/modules/logistics/public/adapters/delivery.server";
import { readBodyWithLimit } from "@/lib/security/body.server";
import { requireCustomerForUserId } from "@/modules/identity/public/auth/authorization.server";
import { assertSameSiteRequest } from "@/modules/identity/public/auth/isolation.server";
import { rateLimitResponse } from "@/lib/security/rate-limit.server";

const schema = z.object({
  merchantId: z.string().trim().min(1).max(128),
  address: z.string().trim().min(8).max(400),
  lat: z.number().finite().min(-90).max(90).optional(),
  lon: z.number().finite().min(-180).max(180).optional(),
  tier: z.enum(["same_day", "next_day", "three_day"]).optional(),
});

export const Route = createFileRoute("/api/mobile/delivery-quote")({
  server: { handlers: { POST: async ({ request }) => {
    assertSameSiteRequest();
    const current = await auth.api.getSession({ headers: request.headers });
    if (!current?.user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
    await requireCustomerForUserId(current.user.id);
    let raw: string;
    try { raw = await readBodyWithLimit(request, 16 * 1024); } catch { return Response.json({ error: "Request too large" }, { status: 413 }); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "Invalid delivery quote request" }, { status: 400 });
    try {
      return Response.json(await requestDeliveryQuoteServer({ data: parsed.data, userId: current.user.id }), { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const limited = rateLimitResponse(error);
      if (limited) return limited;
      console.error("[mobile-delivery-quote] failed", error);
      return Response.json({ error: "Quote failed" }, { status: 400, headers: { "cache-control": "no-store" } });
    }
  } } },
});
