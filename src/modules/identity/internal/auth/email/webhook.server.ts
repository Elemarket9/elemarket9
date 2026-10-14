import { env } from "@/lib/env.server";
import type { EmailWebhookAdapter } from "./webhook.types";
import { getResendEmailWebhookAdapter } from "./providers/resend-webhook.server";

export function getEmailWebhookAdapter(providerKey?: string): EmailWebhookAdapter {
  const selected = (providerKey ?? env("ELEMARKET_EMAIL_PROVIDER") ?? "").trim().toLowerCase();
  if (!selected) throw new Error("Email webhook provider is not configured");
  if (!/^[a-z0-9_-]{2,64}$/.test(selected)) throw new Error("Invalid email provider");
  if (selected === "resend") return getResendEmailWebhookAdapter();
  throw new Error(`Email webhook provider '${selected}' is not configured`);
}
