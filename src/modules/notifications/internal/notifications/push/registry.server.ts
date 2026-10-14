import type { PushProviderAdapter } from "./types";
import { env } from "@/lib/env.server";
import { getFcmPushAdapter } from "./providers/fcm.server";

export function getPushProvider(): PushProviderAdapter {
  const selected = (env("ELEMARKET_PUSH_PROVIDER") ?? "").trim().toLowerCase();
  if (selected === "fcm") return getFcmPushAdapter();
  throw new Error(`Unsupported push provider: ${selected}`);
}
