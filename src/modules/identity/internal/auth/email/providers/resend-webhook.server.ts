import { createHmac, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import type { EmailWebhookAdapter, EmailWebhookResult } from "../webhook.types";

function decodeSecret(secret: string): Buffer {
  const raw = secret.trim();
  const encoded = raw.startsWith("whsec_") ? raw.slice(6) : raw;
  return Buffer.from(encoded, "base64");
}

function verifySignature(payload: string, headers: Headers, secret: string): boolean {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = createHmac("sha256", decodeSecret(secret)).update(`${id}.${timestamp}.${payload}`).digest();
  return signature.split(" ").some((candidate) => {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) return false;
    try {
      const provided = Buffer.from(value, "base64");
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    } catch {
      return false;
    }
  });
}

export class ResendEmailWebhookAdapter implements EmailWebhookAdapter {
  readonly key = "resend";

  async handle(rawBody: string, headers: Headers): Promise<EmailWebhookResult> {
    const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
    if (!secret) throw new Error("Email webhook secret is not configured");
    if (!verifySignature(rawBody, headers, secret)) throw new Error("Invalid email webhook signature");

    let event: { type?: string; created_at?: string; data?: { email_id?: string; to?: string[]; subject?: string } };
    try { event = JSON.parse(rawBody); } catch { throw new Error("Invalid email webhook JSON"); }
    if (!event.type || !event.data?.email_id) throw new Error("Invalid email webhook payload");

    const eventId = headers.get("svix-id");
    const sql = await getSql();
    await sql.query(
      `insert into email_events(id,event_type,email_id,recipient,subject,payload,created_at)
       values($1,$2,$3,$4,$5,$6::jsonb,coalesce($7::timestamptz,now()))
       on conflict (id) do nothing`,
      [eventId, event.type, event.data.email_id, event.data.to?.[0] ?? null, event.data.subject ?? null, rawBody, event.created_at ?? null],
    );
    return { accepted: true, eventId };
  }
}

let singleton: ResendEmailWebhookAdapter | undefined;
export function getResendEmailWebhookAdapter(): ResendEmailWebhookAdapter {
  singleton ??= new ResendEmailWebhookAdapter();
  return singleton;
}
