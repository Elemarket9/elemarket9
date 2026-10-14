import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { auth } from "@/modules/identity/public/auth/server";
import { createPendingCheckoutServer } from "@/modules/ordering/public/checkout";
import { readBodyWithLimit } from "@/lib/security/body.server";
import { rateLimitResponse } from "@/lib/security/rate-limit.server";
import { assertSameSiteRequest } from "@/modules/identity/public/auth/isolation.server";

const schema = z.object({
  idempotencyKey: z.string().min(16).max(128),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(z.object({ productId: z.string().min(1).max(64), variantId: z.string().min(1).max(64).nullable(), quantity: z.number().int().min(1).max(20) })).min(1).max(40),
  quotes: z.array(z.object({ merchantId: z.string().min(1).max(64), quoteId: z.string().min(1).max(64) })).min(1).max(40),
  address: z.string().trim().min(8).max(400),
  method: z.enum(["mobile_money", "card", "bank_transfer"]),
  promoCode: z.string().trim().max(64).regex(/^[A-Za-z0-9_-]{4,64}$/).nullable().optional(),
});

export const Route = createFileRoute("/api/mobile/checkout")({
  server: { handlers: { POST: async ({ request }) => {
    assertSameSiteRequest();
    const current = await auth.api.getSession({ headers: request.headers });
    if (!current?.user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
    let raw: string;
    try { raw = await readBodyWithLimit(request, 64 * 1024); } catch { return Response.json({ error: "Request too large" }, { status: 413 }); }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "Invalid checkout request" }, { status: 400 });
    try {
      return Response.json(await createPendingCheckoutServer(parsed.data, current.user.id), { headers: { "cache-control": "no-store" } });
    } catch (error) {
      const limited = rateLimitResponse(error);
      if (limited) return limited;
      console.error("[mobile-checkout] failed", error);
      return Response.json({ error: "Checkout could not be created" }, { status: 400, headers: { "cache-control": "no-store" } });
    }
  } } },
});
