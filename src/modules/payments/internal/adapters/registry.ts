import { isWorkspacePreview } from "@/lib/env.server";
import { normalizeProviderKey } from "@/modules/payments/internal/provider-policy.server";
import { JsonHttpPaymentAdapter, PreviewPaymentAdapter, type PaymentProviderAdapter } from "./payment";

/**
 * Provider-neutral integration registry.
 *
 * The marketplace core never imports or names a payment vendor. A provider
 * record supplies a driver_key, and deployment configuration maps that driver
 * to an adapter module. Only the adapter contains vendor-specific behavior.
 */
export async function getPaymentAdapter(providerKey: string, driverKey?: string): Promise<PaymentProviderAdapter> {
  const normalized = normalizeProviderKey(providerKey);
  if (normalized.startsWith("preview") && isWorkspacePreview()) {
    return new PreviewPaymentAdapter();
  }

  const driver = (driverKey ?? process.env[`ELEMARKET_PAYMENT_${normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_DRIVER`] ?? "http").trim();

  if (!/^[A-Za-z0-9_-]{2,64}$/.test(driver)) throw new Error("Invalid payment provider driver");

  if (driver.toLowerCase() === "http") {
    const prefix = `ELEMARKET_PAYMENT_${normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    const endpoint = process.env[`${prefix}_ENDPOINT`]?.trim();
    const secret = process.env[`${prefix}_SECRET`]?.trim();
    if (!endpoint || !secret) {
      if (isWorkspacePreview()) return new PreviewPaymentAdapter();
      throw new Error("Payment provider endpoint/credentials are not configured");
    }
    const { assertPublicHttpsEndpoint } = await import("@/lib/security/ssrf.server");
    const publicEndpoint = await assertPublicHttpsEndpoint(endpoint);
    // A header alone does not make an upstream operation idempotent. Generic
    // HTTP providers must explicitly attest that repeated initialization with
    // the same idempotency key returns/reuses the same provider-side payment.
    // Keep the safe default false so an unverified provider can never be used
    // for money movement merely because it accepts our JSON contract.
    const idempotentInitialization = process.env[`${prefix}_IDEMPOTENT_INITIALIZATION`]?.trim().toLowerCase() === "true";
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
    .split(",").map((v) => v.trim()).filter(Boolean);
  if (!allowedModules.includes(moduleSpecifier)) throw new Error(`Payment provider driver '${driver}' module is not allowlisted`);

  const loaded = await import(moduleSpecifier) as { createPaymentAdapter?: (args: { providerKey: string }) => PaymentProviderAdapter };
  if (typeof loaded.createPaymentAdapter !== "function") {
    throw new Error(`Payment provider driver '${driver}' does not export createPaymentAdapter`);
  }
  return loaded.createPaymentAdapter({ providerKey: normalized });
}
