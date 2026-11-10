/** Pure commerce checks shared by checkout, delivery quotes, and unit tests. */

/**
 * @param {string | number} value
 * @returns {number}
 */
export function parsePesewas(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error("Invalid money amount");
  const [cedis, frac = ""] = raw.split(".");
  const pesewas = Number(cedis) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(pesewas)) throw new Error("Invalid money amount");
  return pesewas;
}

export const MAX_DELIVERY_PESEWAS = 1_000_000;
export const MAX_DELIVERY_ETA_MINUTES = 10_080;
export const MAX_DELIVERY_DISTANCE_KM = 100;

/**
 * @param {number} pesewas
 * @returns {string}
 */
export function formatPesewas(pesewas) {
  const cedis = Math.floor(pesewas / 100);
  const fraction = String(pesewas % 100).padStart(2, "0");
  return `${cedis}.${fraction}`;
}

/** Carrier quotes are untrusted. Zero and amounts above the delivery_quotes check are rejected. */
/**
 * @param {string | number} price
 * @returns {string}
 */
export function assertPayableDeliveryPrice(price) {
  const pesewas = parsePesewas(price);
  if (pesewas <= 0 || pesewas > MAX_DELIVERY_PESEWAS) throw new Error("Invalid delivery quote amount");
  return formatPesewas(pesewas);
}

/**
 * @param {{ price: string | number, etaMinutes: number, distanceKm: number }} quote
 */
export function assertDeliveryQuoteBounds(quote) {
  const price = assertPayableDeliveryPrice(quote.price);
  if (!Number.isInteger(quote.etaMinutes) || quote.etaMinutes <= 0 || quote.etaMinutes > MAX_DELIVERY_ETA_MINUTES) {
    throw new Error("Invalid delivery quote eta");
  }
  if (!Number.isFinite(quote.distanceKm) || quote.distanceKm < 0 || quote.distanceKm > MAX_DELIVERY_DISTANCE_KM) {
    throw new Error("Invalid delivery distance");
  }
  return { ...quote, price };
}

/**
 * Flat platform commission, in pesewas. Zero means the caller must omit the charge
 * and leave the provider's own split in place. Delivery is customer-paid and is
 * not added to the commission. A charge that consumes the whole payment is rejected.
 * @param {string | number} amount
 * @param {string | number} platformFee
 * @returns {number}
 */
export function marketplaceSettlementChargePesewas(amount, platformFee) {
  const total = parsePesewas(amount);
  const charge = parsePesewas(platformFee);
  if (total <= 0 || charge < 0 || charge >= total) throw new Error("Invalid settlement split");
  return charge;
}

/** Canonical cart binding stored on delivery_quotes.fingerprint. Migration 0213 recomputes the same text. */
/**
 * @param {{ merchantId: string, address: string, tier: string, items: Array<{ productId?: string, variantId?: string | null, quantity?: number }> }} input
 * @returns {string}
 */
export function quoteCartCanonical({ merchantId, address, tier, items }) {
  const grouped = new Map();
  for (const item of items) {
    const productId = String(item.productId ?? "").trim();
    const variantId = String(item.variantId ?? "").trim();
    const quantity = item.quantity;
    if (!productId || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) throw new Error("Invalid delivery quote item");
    const key = `${productId}\t${variantId}`;
    grouped.set(key, (grouped.get(key) ?? 0) + quantity);
  }
  const lines = [...grouped.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([key, quantity]) => `${key}\t${quantity}`);
  if (!lines.length) throw new Error("Delivery quote requires the merchant cart");
  return `v1\n${String(merchantId).trim()}\n${String(address).trim()}\n${tier}\n${lines.join("\n")}`;
}

const BLOCKED_CSP = new Set(["*", "'none'", "'self'", "'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "data:", "blob:"]);

/** Extra CSP tokens may only be exact https origins. Keywords and wildcards are dropped. */
/**
 * @param {string} raw
 * @returns {string[]}
 */
export function sanitizeCspSources(raw) {
  const origins = [];
  for (const token of String(raw ?? "").split(/\s+/)) {
    const value = token.trim();
    if (!value || BLOCKED_CSP.has(value.toLowerCase())) continue;
    if (value.startsWith("'")) continue;
    try {
      const url = new URL(value.includes("://") ? value : `https://${value}`);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port && url.port !== "443") continue;
      origins.push(url.origin);
    } catch {
      // Ignore malformed operator input rather than injecting it into CSP.
    }
  }
  return [...new Set(origins)];
}
