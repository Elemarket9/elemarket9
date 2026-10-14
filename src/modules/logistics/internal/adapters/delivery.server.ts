import { assertCommerceExecutionAllowed } from "@/lib/security/launch-profile.mjs";
import { z } from "zod";
import { fetchPinnedPublicHttps } from "@/lib/security/pinned-https.server";
import { getSql } from "@/lib/db";
import { isWorkspacePreview } from "@/lib/env.server";
import { requireCustomerForUserId } from "@/modules/identity/public/auth/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { haversineKm, quoteDelivery, type DeliveryTier } from "@/modules/shared/public/money";

export type DeliveryQuoteInput = {
  merchantId: string;
  address: string;
  lat?: number;
  lon?: number;
  tier?: "same_day" | "next_day" | "three_day";
};
export type DeliveryQuoteResult = {
  quoteId: string;
  price: string;
  currency: "GHS";
  etaMinutes: number;
  expiresAt: string;
  tier: "same_day" | "next_day" | "three_day";
  providerReference?: string;
};

export interface DeliveryCarrierAdapter {
  quote(input: DeliveryQuoteInput): Promise<DeliveryQuoteResult>;
}

async function resolveDestination(input: DeliveryQuoteInput): Promise<DeliveryQuoteInput> {
  const { geocodeAddressServer } =
    await import("@/modules/logistics/internal/adapters/location.server");
  // Client coordinates are advisory only. Delivery pricing must use a server-geocoded address.
  const location = await geocodeAddressServer(input.address);
  return { ...input, lat: location.latitude, lon: location.longitude };
}

export class JsonHttpDeliveryAdapter implements DeliveryCarrierAdapter {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
  ) {}
  async quote(input: DeliveryQuoteInput): Promise<DeliveryQuoteResult> {
    const response = await fetchPinnedPublicHttps(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.secret}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Delivery provider returned HTTP ${response.status}`);
    const schema = z.object({
      quoteId: z.string().min(1).max(256),
      price: z
        .string()
        .regex(/^\d{1,9}(?:\.\d{1,2})?$/)
        .refine(
          (v) => Number.isFinite(Number(v)) && Number(v) <= 1_000_000,
          "invalid delivery quote price",
        ),
      currency: z.literal("GHS"),
      etaMinutes: z
        .number()
        .int()
        .positive()
        .max(60 * 24 * 30),
      expiresAt: z.string().datetime(),
      tier: z.enum(["same_day", "next_day", "three_day"]),
      providerReference: z.string().min(1).max(256).optional(),
    });
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Delivery provider response failed validation");
    const expires = Date.parse(parsed.data.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 60 * 60 * 1000)
      throw new Error("Delivery provider returned an invalid quote expiry");
    if (parsed.data.tier !== (input.tier ?? "next_day"))
      throw new Error("Delivery provider returned a different service tier");
    return parsed.data;
  }
}

class PreviewDeliveryAdapter implements DeliveryCarrierAdapter {
  async quote(input: DeliveryQuoteInput): Promise<DeliveryQuoteResult> {
    const sql = await getSql();
    const merchants = await sql.query<{ lat: number; lon: number }>(
      `select lat, lon from merchants where id = $1 and status = 'active'`,
      [input.merchantId],
    );
    const merchant = merchants[0];
    if (!merchant) throw new Error("Merchant is not available for delivery");
    if (input.lat === undefined || input.lon === undefined ||
        !Number.isFinite(input.lat) || !Number.isFinite(input.lon) ||
        Math.abs(input.lat) > 90 || Math.abs(input.lon) > 180) {
      throw new Error("A verified delivery destination is required");
    }
    const distanceKm = haversineKm(Number(merchant.lat), Number(merchant.lon), input.lat, input.lon);
    const tier: DeliveryTier = input.tier ?? "next_day";
    const quoted = quoteDelivery(tier, distanceKm);
    return {
      quoteId: `pq_${crypto.randomUUID()}`,
      price: quoted.price,
      currency: "GHS",
      etaMinutes: quoted.etaMinutes,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      tier,
      providerReference: "preview-delivery",
    };
  }
}

export function getDeliveryAdapter(providerKey: string): DeliveryCarrierAdapter {
  if (!isWorkspacePreview() && providerKey.trim().toLowerCase() === "preview")
    throw new Error("Preview delivery is forbidden in shared environments");
  if (
    providerKey === "preview" ||
    (isWorkspacePreview() && !process.env.ELEMARKET_DELIVERY_PROVIDER)
  ) {
    return new PreviewDeliveryAdapter();
  }
  const normalized = providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const endpoint = process.env[`ELEMARKET_DELIVERY_${normalized}_ENDPOINT`]?.trim();
  const secret = process.env[`ELEMARKET_DELIVERY_${normalized}_SECRET`]?.trim();
  if (!endpoint || !secret) {
    if (isWorkspacePreview()) return new PreviewDeliveryAdapter();
    throw new Error("Delivery provider endpoint/credentials are not configured");
  }
  return new JsonHttpDeliveryAdapter(endpoint, secret);
}

export async function requestDeliveryQuoteServer(input: {
  data: DeliveryQuoteInput;
  userId: string;
}) {
  assertCommerceExecutionAllowed("delivery quote");
  await enforceRateLimit("delivery-quote", {
    windowSeconds: 60,
    maxRequests: 30,
    subject: input.userId,
  });
  const principal = await requireCustomerForUserId(input.userId);
  const providerKey =
    process.env.ELEMARKET_DELIVERY_PROVIDER?.trim() || (isWorkspacePreview() ? "preview" : "");
  if (!providerKey) throw new Error("Delivery provider is not configured");
  const adapter = getDeliveryAdapter(providerKey);
  const data = await resolveDestination(input.data);
  const quote = await adapter.quote(data);
  // Never persist a provider-controlled amount or tier without validating it.
  const deliveryPrice = Number(quote.price);
  if (
    !Number.isFinite(deliveryPrice) ||
    deliveryPrice < 0 ||
    deliveryPrice > 1_000_000 ||
    !/^\d{1,9}(?:\.\d{1,2})?$/.test(quote.price)
  )
    throw new Error("Invalid delivery quote amount");
  if (quote.tier !== (input.data.tier ?? "next_day"))
    throw new Error("Delivery provider returned a mismatched service tier");
  const expires = Date.parse(quote.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 60 * 60 * 1000)
    throw new Error("Invalid delivery quote expiry");
  const sql = await getSql();
  const origin = await sql.query<{ lat: number; lon: number; status: string; verified: boolean }>(
    `select lat,lon,status,verified from merchants where id=$1`,
    [data.merchantId],
  );
  const merchant = origin[0];
  if (!merchant || merchant.status !== "active" || !merchant.verified)
    throw new Error("Merchant is not eligible for delivery");
  const distanceKm = Number(
    haversineKm(
      Number(merchant.lat),
      Number(merchant.lon),
      Number(data.lat),
      Number(data.lon),
    ).toFixed(2),
  );
  if (!Number.isFinite(distanceKm) || distanceKm < 0) throw new Error("Invalid delivery distance");
  const providers = await sql.query<{ id: string }>(
    `select id from delivery_providers where provider_key=$1 and status='active' and ($2::boolean or environment='production')`,
    [providerKey, isWorkspacePreview()],
  );
  if (!providers[0]) throw new Error("Delivery provider is not active in this environment");
  const quoteId = `dq_${crypto.randomUUID()}`;
  const fingerprint = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ ...data, userId: principal.userId })),
  );
  const fingerprintHex = Array.from(new Uint8Array(fingerprint), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  await sql.query(
    `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,dest_lat,dest_lon,expires_at,provider_id,provider_reference)
       values($1,$2,$3,$4,$5,$6,coalesce($7,0),$12,$8,$9,$10,$11,$13,$14)`,
    [
      quoteId,
      principal.userId,
      data.merchantId,
      fingerprintHex,
      quote.tier,
      quote.price,
      quote.etaMinutes,
      data.address,
      data.lat ?? null,
      data.lon ?? null,
      quote.expiresAt,
      distanceKm,
      providers[0].id,
      quote.providerReference ?? quote.quoteId,
    ],
  );
  return { ...quote, id: quoteId, providerKey, latitude: data.lat, longitude: data.lon };
}
