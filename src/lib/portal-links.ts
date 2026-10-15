/** Public navigation configuration only. Authorization stays on the server. */
type Portal = "marketplace" | "seller" | "provider";
const origins: Record<string, string | undefined> = {
  ...(import.meta.env.VITE_ELEMARKET_PORTAL_ORIGINS ?? {}),
};
const explicitOrigins = {
  marketplace: import.meta.env.VITE_ELEMARKET_MARKETPLACE_ORIGIN,
  seller: import.meta.env.VITE_ELEMARKET_SELLER_ORIGIN,
  provider: import.meta.env.VITE_ELEMARKET_PROVIDER_ORIGIN,
};
for (const [portal, origin] of Object.entries(explicitOrigins)) {
  if (origin) origins[portal] = origin.replace(/\/$/, "");
}
export function portalHref(portal: Portal, path = "/"): string {
  const origin = origins[portal] ?? "";
  return `${origin}/${path.replace(/^\/+/, "")}`;
}
export function isMarketplaceOrigin(): boolean {
  if (typeof window === "undefined") return false;
  if (origins.marketplace) return window.location.origin === origins.marketplace;
  return !Object.entries(origins).some(
    ([portal, origin]) => portal !== "marketplace" && origin === window.location.origin,
  );
}
