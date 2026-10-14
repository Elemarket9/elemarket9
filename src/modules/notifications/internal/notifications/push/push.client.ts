import { enableFcmPush } from "./fcm.client";

export async function enablePush(): Promise<{ registered: boolean }> {
  const selected = String(import.meta.env.VITE_ELEMARKET_PUSH_PROVIDER ?? "").trim().toLowerCase();
  if (selected === "fcm") return enableFcmPush();
  throw new Error("Browser push provider is not configured");
}
