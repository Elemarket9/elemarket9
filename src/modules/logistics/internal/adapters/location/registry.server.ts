import { env } from "@/lib/env.server";
import type { LocationProvider } from "../location.server";
import { GeoapifyLocationProvider } from "../providers/geoapify.server";

export function getLocationProvider(providerKey?: string): { key: string; adapter: LocationProvider } {
  const provider = (providerKey ?? env("ELEMARKET_LOCATION_PROVIDER") ?? "").trim().toLowerCase();
  if (!provider) throw new Error("Location capability is not configured");
  if (!/^[a-z0-9_-]{2,64}$/.test(provider)) throw new Error("Invalid location provider");
  if (provider === "geoapify") {
    const apiKey = env("GEOAPIFY_API_KEY");
    if (!apiKey) throw new Error("Location provider credentials are not configured");
    return { key: provider, adapter: new GeoapifyLocationProvider(apiKey) };
  }
  throw new Error(`Location provider '${provider}' is not configured`);
}
