import { createHash } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import type { OtpPurpose, OtpProviderAdapter } from "./types";
import { getOtpAdapter } from "./registry.server";

const DEFAULT_EXPIRY_MINUTES = 5;
const OTP_LENGTH = 6;
const OTP_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;

import { normalizeGhanaPhone as normalizeNumber } from "../phone";

function normalizePurpose(value: string): OtpPurpose {
  if (["signup", "login", "phone_verification", "password_reset", "transactional"].includes(value)) {
    return value as OtpPurpose;
  }
  throw new Error("Invalid OTP purpose");
}

export type RequestOtpInput = {
  number: string;
  purpose: string;
  expiryMinutes?: number;
  userId?: string;
};

export type VerifyOtpInput = {
  challengeId: string;
  code: string;
  userId?: string;
  expectedPurpose?: OtpPurpose;
};

export async function requestOtp(
  input: RequestOtpInput,
  adapter: OtpProviderAdapter = getOtpAdapter(),
) {
  const number = normalizeNumber(input.number);
  const purpose = normalizePurpose(input.purpose);
  const expiryMinutes = input.expiryMinutes ?? DEFAULT_EXPIRY_MINUTES;
  if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > 10) {
    throw new Error("OTP expiry must be between 1 and 10 minutes");
  }

  const destinationKey = createHash("sha256").update(number).digest("hex");
  await enforceRateLimit("otp-request", { windowSeconds: 60, maxRequests: 5 });
  await enforceRateLimit("otp-request-destination", { windowSeconds: 600, maxRequests: 3, subject: destinationKey, identity: "subject" });
  const sql = await getSql();

  const active = await sql.query<{
    id: string;
    created_at: string;
    expires_at: string;
    cooldown_until: string;
  }>(
    `select id, created_at, expires_at, cooldown_until
       from otp_challenges
      where destination = $1 and purpose = $2 and status = 'pending'
      order by created_at desc
      limit 1`,
    [number, purpose],
  );

  if (active[0]) {
    const cooldown = new Date(active[0].cooldown_until).getTime();
    if (Number.isFinite(cooldown) && cooldown > Date.now()) {
      throw new Error("Please wait before requesting another OTP");
    }
    await sql.query(
      `update otp_challenges
          set status = 'superseded', updated_at = now()
        where id = $1 and status = 'pending'`,
      [active[0].id],
    );
  }

  const challengeId = `otp_${crypto.randomUUID().replaceAll("-", "")}`;
  await sql.query(
    `insert into otp_challenges
      (id, user_id, destination, purpose, provider, status, expires_at, attempts, max_attempts, cooldown_until)
     values ($1,$2,$3,$4,$5,'sending',now() + ($6 * interval '1 minute'),0,$7,now() + ($8 * interval '1 second'))`,
    [challengeId, input.userId ?? null, number, purpose, adapter.key, expiryMinutes, MAX_ATTEMPTS, OTP_COOLDOWN_SECONDS],
  );

  try {
    const result = await adapter.send({
      number,
      expiryMinutes,
      length: OTP_LENGTH,
      message: "Your ELEMARKET verification code is %otp_code%. It expires in %expiry% minutes.",
    });

    if (result.code !== "accepted") {
      await sql.query(
        `update otp_challenges set status='failed', provider_message=$2, updated_at=now() where id=$1`,
        [challengeId, result.providerMessage ?? "OTP provider rejected the request"],
      );
      throw new Error("OTP could not be sent");
    }

    await sql.query(
      `update otp_challenges set status='pending', provider_message=$2, updated_at=now() where id=$1 and status='sending'`,
      [challengeId, result.providerMessage ?? null],
    );
    return { challengeId, expiresInSeconds: expiryMinutes * 60, cooldownSeconds: OTP_COOLDOWN_SECONDS };
  } catch (error) {
    await sql.query(
      `update otp_challenges set status='failed', updated_at=now() where id=$1 and status='sending'`,
      [challengeId],
    );
    throw error;
  }
}

export async function verifyOtp(
  input: VerifyOtpInput,
  adapter: OtpProviderAdapter = getOtpAdapter(),
) {
  if (!/^\d{6}$/.test(input.code)) throw new Error("Invalid OTP code");
  const verifyKey = createHash("sha256").update(input.challengeId).digest("hex");
  await enforceRateLimit("otp-verify", { windowSeconds: 60, maxRequests: 30 });
  await enforceRateLimit("otp-verify-challenge", { windowSeconds: 60, maxRequests: 20, subject: verifyKey, identity: "subject" });
  const sql = await getSql();

  const claimed = await sql.query<{
    id: string;
    destination: string;
    attempts: number;
    max_attempts: number;
    expires_at: string;
    purpose: OtpPurpose;
    user_id: string | null;
  }>(
    `update otp_challenges
        set attempts = attempts + 1, updated_at = now()
      where id = $1
        and provider = $4
        and status = 'pending'
        and expires_at > now()
        and attempts < max_attempts
        and ($2::text is null or user_id = $2)
        and ($3::text is null or purpose = $3)
      returning id, destination, attempts, max_attempts, expires_at, purpose, user_id`,
    [input.challengeId, input.userId ?? null, input.expectedPurpose ?? null, adapter.key],
  );

  const challenge = claimed[0];
  if (!challenge) throw new Error("OTP is invalid, expired, or locked");

  let result: Awaited<ReturnType<OtpProviderAdapter["verify"]>>;
  try {
    result = await adapter.verify({ number: challenge.destination, code: input.code });
  } catch (error) {
    await sql.query(
      `update otp_challenges
          set attempts = greatest(attempts - 1, 0), updated_at = now()
        where id = $1 and status = 'pending'`,
      [challenge.id],
    );
    throw error;
  }

  if (result.code === "verified") {
    await withTransaction(async (tx) => {
      // Match confirm_phone_verification's profile -> challenge lock order.
      if (challenge.purpose === "phone_verification") {
        await tx.query(`select user_id from profiles where user_id=$1 for update`, [challenge.user_id]);
      }
      const consumed = await tx.query<{ id: string }>(
        `update otp_challenges
            set status='verified', verified_at=now(), updated_at=now()
          where id=$1 and status='pending' and expires_at>now()
          returning id`,
        [challenge.id],
      );
      if (!consumed[0]) throw new Error("OTP is expired or has already been consumed");
      if (challenge.purpose === "phone_verification") {
        const persisted = await tx.query<{ verified: boolean }>(
          `select confirm_phone_verification($1,$2) as verified`,
          [challenge.user_id, challenge.id],
        );
        if (persisted[0]?.verified !== true) throw new Error("Phone verification was not persisted");
      }
    });
    return { verified: true as const, purpose: challenge.purpose, userId: challenge.user_id, destination: challenge.destination };
  }

  if (result.code === "expired") {
    await sql.query(`update otp_challenges set status='expired', updated_at=now() where id=$1 and status='pending'`, [challenge.id]);
    throw new Error("OTP has expired");
  }

  if (challenge.attempts >= challenge.max_attempts) {
    await sql.query(`update otp_challenges set status='locked', updated_at=now() where id=$1 and status='pending'`, [challenge.id]);
    throw new Error("Too many invalid OTP attempts");
  }

  throw new Error("Invalid OTP code");
}
