import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { readBodyWithLimit } from "./body.server";

const MAX_SKEW_MS = 5 * 60 * 1000;

// Only these GET routes are invoked by the schedules in vercel.json.
const SCHEDULED_GET_PATHS = new Set([
  "/api/internal/expire-payment-orders",
  "/api/internal/sync-enterprise-catalogs",
  "/api/internal/enterprise-order-outbox",
  "/api/internal/enterprise-webhook-worker",
  "/api/internal/reconcile-payments",
  "/api/internal/refresh-eide",
  "/api/internal/dispatch-deliveries",
  "/api/internal/rider-invitations",
  "/api/internal/collection-notifications",
]);

function constantTimeTextEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Vercel cron sends CRON_SECRET as a bearer token. Limit that credential to the
 * scheduled GET routes; manual/POST workers continue to use the HMAC protocol.
 * Enterprise HMAC credentials are independent of the Vercel cron credential.
 */
export async function authorizeScheduledJobRequest(
  request: Request,
  hmacSecret: string | undefined,
): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (
    cronSecret &&
    request.method === "GET" &&
    SCHEDULED_GET_PATHS.has(new URL(request.url).pathname) &&
    constantTimeTextEqual(request.headers.get("authorization") ?? "", `Bearer ${cronSecret}`)
  ) {
    return true;
  }
  return authorizeInternalHmacRequest(request, hmacSecret);
}

/**
 * Authenticates private HTTP worker routes with a short-lived, path/method/body-
 * bound HMAC proof. Requests consume a database-backed nonce so the same signed
 * request cannot be replayed on another instance. The protocol is scheduler and
 * cloud neutral. Scheduled GET routes explicitly opt into bearer authentication
 * through authorizeScheduledJobRequest; all other callers need this proof.
 */
export async function authorizeInternalHmacRequest(
  request: Request,
  secret: string | undefined,
): Promise<boolean> {
  const configured = secret?.trim();
  if (!configured) return false;
  const timestamp = request.headers.get("x-elemarket-sync-timestamp")?.trim() ?? "";
  const signature = request.headers.get("x-elemarket-sync-signature")?.trim().toLowerCase() ?? "";
  const nonce = request.headers.get("x-elemarket-sync-nonce")?.trim() ?? "";
  if (
    !/^\d{10,13}$/.test(timestamp) ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !/^[A-Za-z0-9._~-]{16,128}$/.test(nonce)
  )
    return false;
  const millis = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
  if (!Number.isSafeInteger(millis) || Math.abs(Date.now() - millis) > MAX_SKEW_MS) return false;

  // Bind the signature to the actual request body. These worker endpoints do
  // not consume request bodies, so reading it here cannot interfere with them.
  let bodyText: string;
  try {
    bodyText = await readBodyWithLimit(request, 1024, 5000);
  } catch {
    return false;
  }
  const bodyHash = createHash("sha256").update(bodyText, "utf8").digest("hex");
  const suppliedBodyHash = request.headers.get("x-elemarket-body-sha256")?.trim().toLowerCase();
  if (suppliedBodyHash && !constantTimeTextEqual(bodyHash, suppliedBodyHash)) return false;
  const pathname = new URL(request.url).pathname;
  const message = `${timestamp}.${nonce}.${request.method.toUpperCase()}.${pathname}.${bodyHash}`;
  const expected = createHmac("sha256", configured).update(message, "utf8").digest("hex");
  if (!constantTimeTextEqual(expected, signature)) return false;

  const sql = await getSql();
  await sql.query(`delete from internal_job_nonces where expires_at < now()`);
  const accepted = await sql.query<{ nonce: string }>(
    `insert into internal_job_nonces(nonce,expires_at) values($1,now()+interval '10 minutes') on conflict (nonce) do nothing returning nonce`,
    [nonce],
  );
  return Boolean(accepted[0]);
}
