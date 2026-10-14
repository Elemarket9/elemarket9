import { createFileRoute } from "@tanstack/react-router";
import { requestDeliveryQuoteServer } from "@/modules/logistics/public/adapters/delivery.server";
import { enforceRateLimit, rateLimitResponse } from "@/lib/security/rate-limit.server";
import { readBodyWithLimit } from "@/lib/security/body.server";
import { assertSameSiteRequest } from "@/modules/identity/public/auth/isolation.server";
import { requireCustomer } from "@/modules/identity/public/auth/authorization.server";
import { requireUserId } from "@/modules/identity/public/auth/verify.server";
import { z } from "zod";
const deliveryQuoteSchema = z.object({
  merchantId: z.string().trim().min(1).max(128),
  address: z.string().trim().min(1).max(400),
  lat: z.number().finite().min(-90).max(90).optional(),
  lon: z.number().finite().min(-180).max(180).optional(),
  tier: z.enum(["same_day", "next_day", "three_day"]).optional(),
});

export const Route = createFileRoute("/api/delivery/quote")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          assertSameSiteRequest();
          await enforceRateLimit("delivery-quote", { windowSeconds: 60, maxRequests: 30 });
          const userId = await requireUserId();
          await requireCustomer(userId);
          const rawBody = await readBodyWithLimit(request, 16 * 1024);
          let rawData: unknown;
          try { rawData = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400 }); }
          const parsed = deliveryQuoteSchema.safeParse(rawData);
          if (!parsed.success) return new Response("Invalid delivery quote request", { status: 400 });
          const data = parsed.data;
          return Response.json(await requestDeliveryQuoteServer({ data, userId }));
        } catch (error) {
          const limited = rateLimitResponse(error);
          if (limited) return limited;
          const status = error instanceof Error && /Unauthenticated|Forbidden|Customer|cross-site/i.test(error.message) ? 401 : 400;
          return new Response(status === 401 ? "Unauthorized" : "Quote failed", { status });
        }
      },
    },
  },
});
