import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { getPushProvider } from "./registry.server";
import type { PushMessage, PushPlatform } from "./types";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function registerPushDevice(input: {
  userId: string;
  token: string;
  platform: PushPlatform;
  appVersion?: string;
  deviceId?: string;
}) {
  const token = input.token.trim();
  if (token.length < 20 || token.length > 4096) throw new Error("Invalid push token");
  await enforceRateLimit("push-device-register", { windowSeconds: 3600, maxRequests: 20, subject: input.userId });
  const sql = await getSql();
  const tokenHash = hashToken(token);
  const existing = await sql.query<{ user_id: string }>(`select user_id from push_devices where token_hash=$1`, [tokenHash]);
  if (existing[0] && existing[0].user_id !== input.userId) throw new Error("Push token is already registered to another account");
  // Push providers rotate tokens. When the authenticated client identifies the
  // same physical/app device, retire its older token before registering the new
  // one so a rotation cannot leave duplicate active delivery targets behind.
  if (input.deviceId?.trim()) {
    await sql.query(
      `update push_devices set disabled_at=coalesce(disabled_at,now()), last_error='token_rotated'
        where user_id=$1 and device_id=$2 and token_hash<>$3 and disabled_at is null`,
      [input.userId, input.deviceId.trim(), tokenHash],
    );
  }
  await sql.query(
    `insert into push_devices (id, user_id, token, token_hash, platform, app_version, device_id, last_seen_at)
     values ($3,$1,$2,$3,$4,$5,$6,now())
     on conflict (token_hash) do update set
       user_id = excluded.user_id,
       token = excluded.token,
       platform = excluded.platform,
       app_version = excluded.app_version,
       device_id = excluded.device_id,
       last_seen_at = now(),
       disabled_at = null`,
    [input.userId, token, tokenHash, input.platform, input.appVersion ?? null, input.deviceId ?? null],
  );
  return { registered: true };
}

export async function unregisterPushDevice(input: { userId: string; token: string }) {
  const token = input.token.trim();
  if (!token) throw new Error("Push token is required");
  await enforceRateLimit("push-device-unregister", { windowSeconds: 3600, maxRequests: 20, subject: input.userId });
  const sql = await getSql();
  await sql.query(`delete from push_devices where user_id = $1 and token_hash = $2`, [input.userId, hashToken(token)]);
  return { unregistered: true };
}

export async function sendPushToUser(userId: string, message: PushMessage) {
  const sql = await getSql();
  const devices = await sql.query<{ id: string; token: string }>(
    `select id, token from push_devices where user_id = $1 and disabled_at is null`,
    [userId],
  );
  const provider = getPushProvider();
  const results: Array<{ id: string; accepted: boolean; providerId?: string }> = [];
  for (const device of devices) {
    try {
      const result = await provider.sendToToken(device.token, message);
      await sql.query(
        `update push_devices set last_success_at = now(), failure_count = 0, last_error = null where id = $1`,
        [device.id],
      );
      results.push({ id: device.id, ...result });
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      const terminal = code === "UNREGISTERED" || code === "INVALID_ARGUMENT";
      await sql.query(
        `update push_devices
            set failure_count = failure_count + 1,
                last_error = $2,
                disabled_at = case when $3 then now() else disabled_at end
          where id = $1`,
        [device.id, error instanceof Error ? error.message.slice(0, 500) : "Push delivery failed", terminal],
      );
    }
  }
  return results;
}
