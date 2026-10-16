import { isIP } from "node:net";
import { isWorkspacePreview } from "@/lib/env.server";
import { normalizeProviderKey } from "@/modules/payments/internal/provider-policy.server";
import { loadBundledPaymentDriver } from "./providers/registry";
import {
  JsonHttpPaymentAdapter,
  PreviewPaymentAdapter,
  type PaymentProviderAdapter,
} from "./payment";

/**
 * Provider-neutral integration registry.
 *
 * The marketplace core never imports or names a payment vendor. A provider
 * record supplies a driver_key, and deployment configuration maps that driver
 * to an adapter module. Only the adapter contains vendor-specific behavior.
 */
export async function getPaymentAdapter(
  providerKey: string,
  driverKey?: string,
): Promise<PaymentProviderAdapter> {
  const normalized = normalizeProviderKey(providerKey);
  if (normalized.toLowerCase().startsWith("preview")) {
    if (!isWorkspacePreview())
      throw new Error("Preview payment providers are forbidden in shared environments");
    if (process.env.ELEMARKET_ENABLE_PREVIEW_COMMERCE !== "1")
      throw new Error("Preview commerce requires an explicit isolated development opt-in");
    return new PreviewPaymentAdapter();
  }

  const driver = (
    driverKey ??
    process.env[
      `ELEMARKET_PAYMENT_${normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_DRIVER`
    ] ??
    "http"
  ).trim();

  if (!/^[A-Za-z0-9_-]{2,64}$/.test(driver)) throw new Error("Invalid payment provider driver");

  if (driver.toLowerCase() === "http") {
    const prefix = `ELEMARKET_PAYMENT_${normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const endpoint = process.env[`${prefix}_ENDPOINT`]?.trim();
    const secret = process.env[`${prefix}_SECRET`]?.trim();
    if (!endpoint || !secret) {
      throw new Error("Payment provider endpoint/credentials are not configured");
    }
    const { assertPublicHttpsEndpoint } = await import("@/lib/security/ssrf.server");
    const publicEndpoint = await assertPublicHttpsEndpoint(endpoint);
    // A header alone does not make an upstream operation idempotent. Generic
    // HTTP providers must explicitly attest that repeated initialization with
    // the same idempotency key returns/reuses the same provider-side payment.
    // Keep the safe default false so an unverified provider can never be used
    // for money movement merely because it accepts our JSON contract.
    const idempotentInitialization =
      process.env[`${prefix}_IDEMPOTENT_INITIALIZATION`]?.trim().toLowerCase() === "true";
    return new JsonHttpPaymentAdapter(publicEndpoint.toString(), secret, idempotentInitialization);
  }

  // Driver modules are deployment configuration, not marketplace business logic.
  // This lets a bank, PSP, or future provider be added without modifying the core.
  const moduleKey = `ELEMARKET_PAYMENT_DRIVER_${driver.toUpperCase()}_MODULE`;
  const moduleSpecifier = process.env[moduleKey]?.trim();
  if (!moduleSpecifier) throw new Error(`Payment provider driver '${driver}' is not configured`);
  // Dynamic modules are deployment-controlled. Keep an explicit allowlist so an
  // accidentally attacker-controlled environment value cannot become arbitrary
  // server-side module loading.
  const allowedModules = (process.env.ELEMARKET_PAYMENT_ALLOWED_MODULES ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!allowedModules.includes(moduleSpecifier))
    throw new Error(`Payment provider driver '${driver}' module is not allowlisted`);

  const bundled = await loadBundledPaymentDriver(moduleSpecifier);
  if (!bundled && moduleSpecifier.startsWith("builtin:"))
    throw new Error("Unknown bundled payment driver");
  const loaded = (bundled ?? (await import(moduleSpecifier))) as {
    createPaymentAdapter?: (args: { providerKey: string }) => PaymentProviderAdapter;
  };
  if (typeof loaded.createPaymentAdapter !== "function") {
    throw new Error(`Payment provider driver '${driver}' does not export createPaymentAdapter`);
  }
  return loaded.createPaymentAdapter({ providerKey: normalized });
}

/** Readiness for new charges only; settlement and refund recovery use their own contracts. */
export function assertPaymentInitializationReady(
  adapter: PaymentProviderAdapter,
  providerKey: string,
) {
  if (
    adapter?.supportsIdempotentInitialization !== true ||
    typeof adapter.createPayment !== "function"
  )
    throw new Error("Payment provider initialization is not certified for safe retries");
  if (isWorkspacePreview()) return;
  if (
    typeof adapter.verifyWebhook !== "function" ||
    typeof adapter.parseWebhook !== "function" ||
    typeof adapter.verifyTransaction !== "function"
  )
    throw new Error("Payment provider requires signed webhooks and transaction verification");
  const prefix = normalizeProviderKey(providerKey)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  const hosts = (process.env[`ELEMARKET_PAYMENT_${prefix}_CHECKOUT_HOSTS`] ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (
    !hosts.length ||
    hosts.some((host) => {
      try {
        const url = new URL(`https://${host}`);
        return (
          url.hostname !== host ||
          url.host !== host ||
          url.pathname !== "/" ||
          Boolean(url.username || url.password || url.search || url.hash) ||
          !host.includes(".") ||
          host.endsWith(".localhost")
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error("Payment provider checkout hosts are not configured safely");
  getPaymentCallbackOrigin();
}

export function getPaymentCallbackOrigin(): string | undefined {
  const value = process.env.ELEMARKET_PUBLIC_URL?.trim() || process.env.BETTER_AUTH_URL?.trim();
  if (!value && isWorkspacePreview()) return undefined;
  if (!value) throw new Error("Payment callback origin is not configured");
  const url = new URL(value);
  const localHttp =
    isWorkspacePreview() &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (!localHttp && url.port && url.port !== "443")
  )
    throw new Error("Payment callback must be a secure HTTPS origin");
  if (!isWorkspacePreview()) {
    if (
      isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost")
    )
      throw new Error("Payment callback must use the public marketplace hostname");
    const canonical = process.env.BETTER_AUTH_URL?.trim();
    if (canonical && new URL(canonical).origin !== url.origin)
      throw new Error("Payment callback must use the canonical marketplace origin");
  }
  return url.origin;
}
