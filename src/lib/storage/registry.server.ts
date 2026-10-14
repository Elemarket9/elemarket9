import { env } from "@/lib/env.server";
import type { StorageProvider } from "./provider";
import { CloudflareR2StorageProvider } from "./r2.server";

export function getStorageProvider(providerKey?: string): StorageProvider {
  const provider = (providerKey ?? env("ELEMARKET_STORAGE_PROVIDER") ?? "").trim().toLowerCase();
  if (!provider) throw new Error("Storage capability is not configured");
  if (!/^[a-z0-9_-]{2,64}$/.test(provider)) throw new Error("Invalid storage provider");
  if (provider === "r2") return new CloudflareR2StorageProvider();
  throw new Error(`Storage provider '${provider}' is not configured`);
}
