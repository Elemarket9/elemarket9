import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_MS = 5 * 60 * 1000;

export function signBrandWebhook(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function signBrandWebhookV2(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** Timestamp is required. A body-only signature can be replayed forever. */
export function brandWebhookTimestampFresh(timestamp: string | null, now = Date.now()): boolean {
  if (!timestamp) return false;
  const trimmed = timestamp.trim();
  if (!/^\d{10,13}$/.test(trimmed)) return false;
  const millis = trimmed.length === 10 ? Number(trimmed) * 1000 : Number(trimmed);
  return Number.isSafeInteger(millis) && Math.abs(now - millis) <= MAX_SKEW_MS;
}

export function verifyBrandWebhook(
  secret: string,
  rawBody: string,
  signature: string | null,
  timestamp: string | null = null,
  now = Date.now(),
): boolean {
  if (!signature || !brandWebhookTimestampFresh(timestamp, now)) return false;
  const digest = signBrandWebhookV2(secret, timestamp!.trim(), rawBody);
  const expected = Buffer.from(digest, "hex");
  const suppliedText = signature.trim().replace(/^sha256=/, "");
  if (!/^[a-f0-9]{64}$/i.test(suppliedText)) return false;
  const supplied = Buffer.from(suppliedText, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
