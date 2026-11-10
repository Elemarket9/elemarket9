import { isWorkspacePreview } from "@/lib/env.server";
import type { PayoutDriver } from "./payout";
import { loadBundledPayoutDriver } from "./providers/registry";

/**
 * Provider-neutral payout driver registry.
 *
 * ELEMARKET_PAYOUT_DRIVER selects the driver used for NEW payouts:
 *   signed-http  generic signed HTTP contract (ELEMARKET_PAYOUT_HTTP_ENDPOINT,
 *                ELEMARKET_PAYOUT_HTTP_SECRET, optional ELEMARKET_PAYOUT_HTTP_REMOTE_FEES=1)
 *   sandbox      development only, with ELEMARKET_ENABLE_PAYOUT_SANDBOX=1
 *   <name>       ELEMARKET_PAYOUT_DRIVER_<NAME>_MODULE, which must be listed in
 *                ELEMARKET_PAYOUT_ALLOWED_MODULES
 * Payouts in flight keep the driver they were created with.
 */
export function activePayoutDriverKey(): string {
  const key = process.env.ELEMARKET_PAYOUT_DRIVER?.trim();
  if (!key) throw new Error("Merchant payouts are not configured");
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(key)) throw new Error("Invalid payout driver");
  return key;
}

const cache = new Map<string, Promise<PayoutDriver>>();

export function getPayoutDriver(key: string = activePayoutDriverKey()): Promise<PayoutDriver> {
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(key)) return Promise.reject(new Error("Invalid payout driver"));
  let driver = cache.get(key);
  if (!driver) {
    driver = loadDriver(key);
    cache.set(key, driver);
    driver.catch(() => cache.delete(key));
  }
  return driver;
}

async function loadDriver(key: string): Promise<PayoutDriver> {
  if (key === "sandbox") {
    if (!isWorkspacePreview() || process.env.ELEMARKET_ENABLE_PAYOUT_SANDBOX !== "1")
      throw new Error("The payout sandbox is only available in isolated development");
    const { SandboxPayoutDriver } = await import("./sandbox");
    return new SandboxPayoutDriver();
  }
  if (key === "signed-http") {
    const endpoint = process.env.ELEMARKET_PAYOUT_HTTP_ENDPOINT?.trim();
    const secret = process.env.ELEMARKET_PAYOUT_HTTP_SECRET?.trim();
    if (!endpoint || !secret) throw new Error("Payout endpoint/credentials are not configured");
    const [{ SignedHttpPayoutDriver }, { fetchPinnedPublicHttps }] = await Promise.all([
      import("./signed-http"),
      import("@/lib/security/pinned-https.server"),
    ]);
    return new SignedHttpPayoutDriver(key, endpoint, secret, (url, init) => fetchPinnedPublicHttps(url, init), {
      quoteFeesRemotely: process.env.ELEMARKET_PAYOUT_HTTP_REMOTE_FEES === "1",
    });
  }
  const specifier = process.env[`ELEMARKET_PAYOUT_DRIVER_${key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODULE`]?.trim();
  if (!specifier) throw new Error(`Payout driver '${key}' is not configured`);
  const allowed = (process.env.ELEMARKET_PAYOUT_ALLOWED_MODULES ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!allowed.includes(specifier)) throw new Error(`Payout driver '${key}' module is not allowlisted`);
  const bundled = await loadBundledPayoutDriver(specifier);
  if (!bundled && specifier.startsWith("builtin:")) throw new Error("Unknown bundled payout driver");
  const loaded = (bundled ?? (await import(/* @vite-ignore */ specifier))) as {
    createPayoutDriver?: (args: { key: string }) => PayoutDriver;
  };
  if (typeof loaded.createPayoutDriver !== "function")
    throw new Error(`Payout driver '${key}' does not export createPayoutDriver`);
  const driver = loaded.createPayoutDriver({ key });
  if (driver.supportsIdempotentPayouts !== true)
    throw new Error(`Payout driver '${key}' must guarantee idempotent payouts`);
  return driver;
}

/** Test seam: forget cached drivers after configuration changes. */
export function resetPayoutDriverCache() {
  cache.clear();
}
