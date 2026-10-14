/** Integer pesewas — never trust IEEE floats for GHS. */
export function toPesewas(value: string | number): number {
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value * 100 - Math.round(value * 100)) > 1e-9)) {
    throw new Error("invalid money: at most two decimal places are supported");
  }
  const raw = typeof value === "number" ? String(value) : String(value).trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error("invalid money: at most two decimal places are supported");
  }
  const negative = raw.startsWith("-");
  const [cedis, frac = ""] = raw.replace("-", "").split(".");
  const pesewas = Number(cedis) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(pesewas)) throw new Error("invalid money");
  return negative ? -pesewas : pesewas;
}

export function fromPesewas(pesewas: number): string {
  const sign = pesewas < 0 ? "-" : "";
  const abs = Math.abs(pesewas);
  const cedis = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, "0");
  return `${sign}${cedis}.${p}`;
}

export function formatGhs(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "GH₵ —";
  return `GH₵ ${n.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export const DELIVERY_TIERS = ["same_day", "next_day", "three_day"] as const;
export type DeliveryTier = (typeof DELIVERY_TIERS)[number];

export const DELIVERY_COPY: Record<
  DeliveryTier,
  { label: string; detail: string }
> = {
  same_day: { label: "Same day", detail: "Arrives today" },
  next_day: { label: "Next day", detail: "Arrives tomorrow" },
  three_day: { label: "3-day", detail: "Arrives within 3 days" },
};

const BASE_PESEWAS: Record<DeliveryTier, number> = {
  same_day: 2800,
  next_day: 1800,
  three_day: 1200,
};
const PER_KM_PESEWAS: Record<DeliveryTier, number> = {
  same_day: 350,
  next_day: 220,
  three_day: 140,
};

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371.0088;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Server-only delivery price. Never accept a client-supplied fee. */
export function quoteDelivery(tier: DeliveryTier, distanceKm: number): {
  price: string;
  etaMinutes: number;
  distanceKm: number;
} {
  const km = Math.min(100, Math.max(0.5, distanceKm));
  const pesewas = Math.min(
    18000,
    BASE_PESEWAS[tier] + Math.round(PER_KM_PESEWAS[tier] * km),
  );
  const eta =
    tier === "same_day"
      ? Math.min(240, Math.round(70 + km * 8))
      : tier === "next_day"
        ? 1440
        : 4320;
  return { price: fromPesewas(pesewas), etaMinutes: eta, distanceKm: km };
}
