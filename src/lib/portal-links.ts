/** Non-secret frontend navigation configuration. Server authorization NEVER depends on these URLs.
 * Explicit VITE_* values must match the Caddy environment at build time. */
type Portal = "marketplace" | "seller" | "provider";
const explicitOrigins: Record<Portal, string | undefined> = {
  marketplace: import.meta.env.VITE_ELEMARKET_MARKETPLACE_ORIGIN,
  seller: import.meta.env.VITE_ELEMARKET_SELLER_ORIGIN,
  provider: import.meta.env.VITE_ELEMARKET_PROVIDER_ORIGIN,
};
const prefixes = ["festus", "staff", "seller", "partners"];

function fallbackOrigin(portal: Portal): string {
  if (typeof window === "undefined") return "";
  const { hostname, protocol, port } = window.location;
  const parts = hostname.split(".");
  const root = prefixes.includes(parts[0]) ? parts.slice(1).join(".") : hostname;
  const target = portal === "marketplace" ? root : `${portal === "provider" ? "partners" : "seller"}.${root}`;
  return `${protocol}//${target}${port ? `:${port}` : ""}`;
}
export function portalHref(portal: Portal, path = "/"): string {
  const explicit = explicitOrigins[portal]?.replace(/\/$/, "");
  const origin = explicit || fallbackOrigin(portal);
  // SSR fallback is same-origin only; use VITE_* origins for deterministic server HTML.
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}
export function isMarketplaceOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const origin = explicitOrigins.marketplace?.replace(/\/$/, "");
  if (origin) return window.location.origin === origin;
  return !prefixes.includes(window.location.hostname.split(".")[0]);
}
