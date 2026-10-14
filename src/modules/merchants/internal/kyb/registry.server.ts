import { env } from "@/lib/env.server";
import type { KYBProvider } from "./provider";
import { getKybProvider as getConfiguredFylingsAdapter } from "./providers/fylings.server";

/** Optional KYB provider selection. Marketplace verification decisions and
 * manual review remain independent of any external KYB brand.
 */
export function getKybProvider(): KYBProvider | null {
  const key = (env("ELEMARKET_KYB_PROVIDER") ?? "").trim().toLowerCase();
  if (!key) return null; // no API: authorized manual administrative review remains available
  if (!/^[a-z0-9_-]{2,64}$/.test(key)) throw new Error("Invalid KYB provider configuration");
  if (key === "fylings") return getConfiguredFylingsAdapter();
  throw new Error("KYB provider is not registered");
}
