import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { getEmailAdapter } from "./registry.server";

const DEFAULT_EXPIRY_MINUTES = 5;
const OTP_LENGTH = 6;
const OTP_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new Error("Invalid email address");
  }
  return email;
}

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET?.trim();
  if (!value) throw new Error("BETTER_AUTH_SECRET is not configured");
  return value;
}

function hashCode(challengeId: string, code: string): string {
  return createHmac("sha256", secret()).update(`${challengeId}:${code}`).digest("hex");
}

function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(OTP_LENGTH, "0");
}

function otpHtml(code: string, expiryMinutes: number): string {
  return `<div style="font-family:Arial,sans-serif;line-height:1.5;max-width:560px;margin:auto"><h2>ELEMARKET verification code</h2><p>Your verification code is:</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in ${expiryMinutes} minutes.</p><p>If you did not request this code, you can safely ignore this email.</p></div>`;
}

export type RequestEmailOtpInput = {
  email: string;
  purpose: "signup" | "login" | "password_reset" | "transactional";
  expiryMinutes?: number;
  userId?: string;
  name?: string;
};

export async function requestEmailOtp(
  input: RequestEmailOtpInput,
  adapter = getEmailAdapter(),
) {
  const email = normalizeEmail(input.email);
  const expiryMinutes = input.expiryMinutes ?? DEFAULT_EXPIRY_MINUTES;
  if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > 10) {
    throw new Error("OTP expiry must be between 1 and 10 minutes");
  }

  const destinationKey = createHmac("sha256", secret()).update(email).digest("hex");
  await enforceRateLimit("email-otp-request-ip", { windowSeconds: 60, maxRequests: 20 });
  await enforceRateLimit("email-otp-request-destination", { windowSeconds: 60, maxRequests: 5, subject: destinationKey, identity: "subject" });
  const sql = await getSql();
  const active = await sql.query<{ id: string; cooldown_until: string }>(
    `select id, cooldown_until
       from otp_challenges
      where destination=$1 and purpose=$2 and provider=$3 and status in ('sending','pending')
      order by created_at desc limit 1`,
    [email, input.purpose, adapter.key],
  );

  if (active[0]) {
    const cooldown = new Date(active[0].cooldown_until).getTime();
    if (Number.isFinite(cooldown) && cooldown > Date.now()) throw new Error("Please wait before requesting another OTP");
    await sql.query(`update otp_challenges set status='superseded', updated_at=now() where id=$1 and status in ('sending','pending')`, [active[0].id]);
  }

  const userRows = await sql.query<{ id: string }>(`select "id" as id from "user" where lower("email") = $1 limit 1`, [email]);
  if (input.purpose === "signup" && !input.userId && userRows[0]) {
    throw new Error("An account already exists for this email; use sign in or password reset");
  }
  const resolvedUserId = input.userId ?? userRows[0]?.id ?? null;

  const challengeId = `otp_${crypto.randomUUID().replaceAll("-", "")}`;
  const code = generateCode();
  const codeHash = hashCode(challengeId, code);

  try {
    await sql.query(
    `insert into otp_challenges
      (id,user_id,destination,purpose,provider,status,expires_at,attempts,max_attempts,cooldown_until,code_hash)
     values ($1,$2,$3,$4,$5,'sending',now()+($6 * interval '1 minute'),0,$7,now()+($8 * interval '1 second'),$9)`,
    [challengeId, resolvedUserId, email, input.purpose, adapter.key, expiryMinutes, MAX_ATTEMPTS, OTP_COOLDOWN_SECONDS, codeHash],
    );
  } catch (error) {
    if (error instanceof Error && /duplicate|unique/i.test(error.message)) {
      throw new Error("Please wait before requesting another OTP");
    }
    throw error;
  }

  try {
    const result = await adapter.send({
      to: email,
      kind: "email_otp",
      subject: "Your ELEMARKET verification code",
      text: `Hello${input.name ? ` ${input.name}` : ""}, your ELEMARKET verification code is ${code}. It expires in ${expiryMinutes} minutes. If you did not request this code, ignore this email.`,
      html: otpHtml(code, expiryMinutes),
      idempotencyKey: `elemarket-otp/${challengeId}`,
    });
    if (!result.accepted) throw new Error("OTP could not be sent");
    await sql.query(
      `update otp_challenges set status='pending',provider_message=$2,updated_at=now() where id=$1 and status='sending'`,
      [challengeId, result.providerMessage ?? result.providerId ?? null],
    );
    return { challengeId, expiresInSeconds: expiryMinutes * 60, cooldownSeconds: OTP_COOLDOWN_SECONDS };
  } catch (error) {
    await sql.query(`update otp_challenges set status='failed',updated_at=now() where id=$1 and status='sending'`, [challengeId]);
    throw error;
  }
}

export async function verifyEmailOtp(input: { challengeId: string; code: string; userId?: string; expectedPurpose?: RequestEmailOtpInput["purpose"] }) {
  if (!/^\d{6}$/.test(input.code)) throw new Error("Invalid OTP code");
  const verifyKey = createHmac("sha256", secret()).update(input.challengeId).digest("hex");
  await enforceRateLimit("email-otp-verify-ip", { windowSeconds: 60, maxRequests: 30 });
  await enforceRateLimit("email-otp-verify-challenge", { windowSeconds: 60, maxRequests: 20, subject: verifyKey, identity: "subject" });
  const sql = await getSql();
  const claimed = await sql.query<{ id: string; code_hash: string; attempts: number; max_attempts: number; purpose: RequestEmailOtpInput["purpose"]; user_id: string | null; destination: string }>(
    `update otp_challenges set attempts=attempts+1,updated_at=now()
      where id=$1 and provider=$4 and status='pending' and expires_at>now() and attempts<max_attempts
        and ($2::text is null or user_id=$2) and ($3::text is null or purpose=$3)
      returning id,code_hash,attempts,max_attempts,purpose,user_id,destination`,
    [input.challengeId, input.userId ?? null, input.expectedPurpose ?? null, getEmailAdapter().key],
  );
  const challenge = claimed[0];
  if (!challenge) throw new Error("OTP is invalid, expired, or locked");

  if (!challenge.code_hash || !/^[a-f0-9]{64}$/i.test(challenge.code_hash)) throw new Error("OTP is invalid, expired, or locked");
  const expected = Buffer.from(challenge.code_hash, "hex");
  const actual = Buffer.from(hashCode(challenge.id, input.code), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    if (challenge.attempts >= challenge.max_attempts) {
      await sql.query(`update otp_challenges set status='locked',updated_at=now() where id=$1 and status='pending'`, [challenge.id]);
      throw new Error("Too many invalid OTP attempts");
    }
    throw new Error("Invalid OTP code");
  }

  const consumed = await sql.query<{ id: string }>(
    `update otp_challenges set status='verified',verified_at=now(),updated_at=now() where id=$1 and status='pending' returning id`,
    [challenge.id],
  );
  if (!consumed[0]) throw new Error("OTP has already been consumed");

  if (challenge.purpose === "signup" || challenge.purpose === "login") {
    await sql.query(
      `update "user" set "emailVerified" = true, "updatedAt" = now()
        where "id" = $1 and lower("email") = $2`,
      [challenge.user_id, challenge.destination],
    );
  }

  return { verified: true as const, purpose: challenge.purpose, userId: challenge.user_id, destination: challenge.destination };
}
