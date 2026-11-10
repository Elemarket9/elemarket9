import { createHash } from "node:crypto";
import { z } from "zod";
import { fetchPinnedPublicHttps } from "@/lib/security/pinned-https.server";
import { getSql } from "@/lib/db";
import { isWorkspacePreview } from "@/lib/env.server";
import { requireCustomerForUserId } from "@/modules/identity/public/auth/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { haversineKm, quoteDelivery, type DeliveryTier } from "@/modules/shared/public/money";
import {
  assertDeliveryQuoteBounds,
  formatPesewas,
  parsePesewas,
  quoteCartCanonical,
} from "@/lib/commerce-guards.mjs";

export type DeliveryQuoteItem = { productId: string; variantId?: string | null; quantity: number };
export type DeliveryQuoteInput = {
  merchantId: string;
  address: string;
  lat?: number;
  lon?: number;
  tier?: "same_day" | "next_day" | "three_day";
  items?: DeliveryQuoteItem[];
  itemCount?: number;
  declaredValue?: string;
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
      body: JSON.stringify({
        merchantId: input.merchantId,
        address: input.address,
        lat: input.lat,
        lon: input.lon,
        tier: input.tier ?? "next_day",
        itemCount: input.itemCount ?? 0,
        declaredValue: input.declaredValue ?? "0.00",
      }),
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
      etaMinutes: z.number().int().positive().max(60 * 24 * 7),
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
    if (
      input.lat === undefined ||
      input.lon === undefined ||
      !Number.isFinite(input.lat) ||
      !Number.isFinite(input.lon) ||
      Math.abs(input.lat) > 90 ||
      Math.abs(input.lon) > 180
    ) {
      throw new Error("A verified delivery destination is required");
    }
    const distanceKm = haversineKm(
      Number(merchant.lat),
      Number(merchant.lon),
      input.lat,
      input.lon,
    );
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
  if (providerKey.trim().toLowerCase() === "preview") {
    if (process.env.ELEMARKET_ENABLE_PREVIEW_COMMERCE !== "1")
      throw new Error("Preview commerce requires an explicit isolated development opt-in");
    return new PreviewDeliveryAdapter();
  }
  const normalized = providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const endpoint = process.env[`ELEMARKET_DELIVERY_${normalized}_ENDPOINT`]?.trim();
  const secret = process.env[`ELEMARKET_DELIVERY_${normalized}_SECRET`]?.trim();
  if (!endpoint || !secret) {
    throw new Error("Delivery provider endpoint/credentials are not configured");
  }
  return new JsonHttpDeliveryAdapter(endpoint, secret);
}

export async function requestDeliveryQuoteServer(input: {
  data: DeliveryQuoteInput;
  userId: string;
}) {
  await enforceRateLimit("delivery-quote", {
    windowSeconds: 60,
    maxRequests: 30,
    subject: input.userId,
  });
  const principal = await requireCustomerForUserId(input.userId);
  const providerKey =
    process.env.ELEMARKET_DELIVERY_PROVIDER?.trim() || "";
  if (!providerKey) throw new Error("Delivery provider is not configured");
  const adapter = getDeliveryAdapter(providerKey);
  const destination = await resolveDestination(input.data);
  const cart = await quotedCart(destination.merchantId, input.data.items ?? []);
  const data = { ...destination, itemCount: cart.itemCount, declaredValue: cart.declaredValue };
  const quote = await adapter.quote(data);
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
  const bounded = assertDeliveryQuoteBounds({ price: quote.price, etaMinutes: quote.etaMinutes, distanceKm });
  const providers = await sql.query<{ id: string }>(
    `select id from delivery_providers where provider_key=$1 and status='active' and ($2::boolean or environment='production')`,
    [providerKey, isWorkspacePreview()],
  );
  if (!providers[0]) throw new Error("Delivery provider is not active in this environment");
  const quoteId = `dq_${crypto.randomUUID()}`;
  const fingerprintHex = createHash("sha256")
    .update(quoteCartCanonical({
      merchantId: data.merchantId,
      address: data.address,
      tier: quote.tier,
      items: cart.items,
    }))
    .digest("hex");
  await sql.query(
    `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,dest_lat,dest_lon,expires_at,provider_id,provider_reference)
       values($1,$2,$3,$4,$5,$6,$7,$12,$8,$9,$10,$11,$13,$14)`,
    [
      quoteId,
      principal.userId,
      data.merchantId,
      fingerprintHex,
      quote.tier,
      bounded.price,
      bounded.etaMinutes,
      data.address,
      data.lat ?? null,
      data.lon ?? null,
      quote.expiresAt,
      bounded.distanceKm,
      providers[0].id,
      quote.providerReference ?? quote.quoteId,
    ],
  );
  return { ...quote, price: bounded.price, id: quoteId, providerKey, latitude: data.lat, longitude: data.lon };
}

async function quotedCart(merchantId: string, items: DeliveryQuoteItem[]) {
  if (!items.length) throw new Error("Delivery quote requires the merchant cart");
  const sql = await getSql();
  const productIds = [...new Set(items.map((item) => item.productId))];
  const products = await sql.query<{ id: string; price: string }>(
    `select id, price::text as price from products where merchant_id=$1 and id = any($2::text[]) and status='active'`,
    [merchantId, productIds],
  );
  const variants = await sql.query<{ id: string; product_id: string; price: string }>(
    `select id, product_id, price::text as price from product_variants where product_id = any($1::text[]) and status='active'`,
    [productIds],
  );
  const productPrice = new Map(products.map((row) => [row.id, row.price]));
  const variantPrice = new Map(variants.map((row) => [`${row.product_id}\t${row.id}`, row.price]));
  const accepted: DeliveryQuoteItem[] = [];
  let declared = 0;
  let itemCount = 0;
  for (const item of items) {
    if (!productPrice.has(item.productId)) continue;
    const variantId = item.variantId?.trim() || null;
    const price = variantId ? variantPrice.get(`${item.productId}\t${variantId}`) : productPrice.get(item.productId);
    if (!price) throw new Error("Delivery quote item is not available");
    accepted.push({ productId: item.productId, variantId, quantity: item.quantity });
    declared += parsePesewas(price) * item.quantity;
    itemCount += item.quantity;
  }
  if (!accepted.length || !Number.isSafeInteger(declared)) throw new Error("Delivery quote requires the merchant cart");
  return { items: accepted, itemCount, declaredValue: formatPesewas(declared) };
}

/** Optional carrier handoff. Manual partner-portal dispatch remains the default. */
export async function notifyCarrierOfJob(input: { orderId: string; jobId: string; providerKey: string; providerReference: string | null }) {
  const normalized = input.providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const endpoint = process.env[`ELEMARKET_DELIVERY_${normalized}_DISPATCH_ENDPOINT`]?.trim();
  if (!endpoint) return { notified: false as const };
  const secret = process.env[`ELEMARKET_DELIVERY_${normalized}_SECRET`]?.trim();
  if (!secret) throw new Error("Delivery dispatch credentials are not configured");
  const response = await fetchPinnedPublicHttps(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ orderId: input.orderId, jobId: input.jobId, providerReference: input.providerReference }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Delivery provider dispatch returned HTTP ${response.status}`);
  return { notified: true as const };
}
