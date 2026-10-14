import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";

export type DeliveryQuoteInput = { merchantId: string; address: string; lat?: number; lon?: number; tier?: "same_day" | "next_day" | "three_day" };
export type DeliveryQuoteResult = { quoteId: string; price: string; currency: "GHS"; etaMinutes: number; expiresAt: string; tier: "same_day" | "next_day" | "three_day"; providerReference?: string };

const quoteRequestSchema = z.object({
  merchantId: z.string().min(1).max(64),
  address: z.string().trim().min(8).max(400),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  tier: z.enum(["same_day", "next_day", "three_day"]).optional(),
});

export const requestDeliveryQuote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(quoteRequestSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const { requestDeliveryQuoteServer } = await import("@/modules/logistics/internal/adapters/delivery.server");
    return requestDeliveryQuoteServer({ data, userId: userId });
  });
