import type { EmailProviderAdapter } from "./types";
import { env } from "@/lib/env.server";
import { getResendEmailAdapter } from "./providers/resend.server";

export function getEmailAdapter(providerKey?: string): EmailProviderAdapter {
  const selected = (providerKey ?? env("ELEMARKET_EMAIL_PROVIDER") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,64}$/.test(selected)) throw new Error("Invalid email provider");
  if (selected === "resend") return getResendEmailAdapter();
  throw new Error(`Email provider '${selected}' is not configured`);
}
