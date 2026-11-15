/**
 * Validate a checkout link returned by the authenticated marketplace payment
 * endpoint. Never accept a URL supplied by an app deep link or other navigation
 * parameters as trusted payment authority.
 */
export function requireServerCheckoutUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 2048 ||
      /[\u0000-\u001f\u007f\\]/.test(value) || value !== value.trim()) throw new Error("Payment checkout URL is unavailable");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Payment checkout URL is invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.port && url.port !== "443") {
    throw new Error("Payment provider must use a secure HTTPS checkout");
  }
  // Preserve the exact server-provided link, including opaque provider
  // parameters. The backend enforces the configured provider host allowlist.
  return value;
}
