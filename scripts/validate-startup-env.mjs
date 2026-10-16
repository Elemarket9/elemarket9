#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { getPortalConfiguration } from "../src/lib/security/portal-policy.mjs";
// Vendor-specific requirements are deployment registry metadata. This gate
// must never make a particular vendor part of marketplace policy.
const providerCapabilities = JSON.parse(
  readFileSync(new URL("../config/provider-capabilities.json", import.meta.url), "utf8"),
);
const providerKeyPattern = /^[a-z0-9_-]{2,64}$/;
function validateProviderCapability(capability, environmentKey) {
  const selected = env(environmentKey)?.toLowerCase();
  if (!selected || !providerKeyPattern.test(selected)) {
    console.error(`[startup] ${environmentKey} must select a registered provider.`);
    process.exit(1);
  }
  const descriptor = providerCapabilities[capability]?.[selected];
  if (!descriptor || !Array.isArray(descriptor.requiredEnv)) {
    console.error(`[startup] ${capability} provider is not registered in deployment capabilities.`);
    process.exit(1);
  }
  const missing = descriptor.requiredEnv.filter(
    (key) => !/^[A-Z][A-Z0-9_]*$/.test(key) || !env(key),
  );
  if (missing.length) {
    console.error(
      `[startup] ${capability} provider credentials/configuration are missing: ${missing.join(", ")}`,
    );
    process.exit(1);
  }
  if (descriptor.jsonCredential) {
    const { env: key, fields } = descriptor.jsonCredential;
    try {
      const parsed = JSON.parse(env(key));
      if (
        !Array.isArray(fields) ||
        fields.some((name) => typeof parsed?.[name] !== "string" || !parsed[name].trim())
      )
        throw new Error("missing credential properties");
    } catch {
      console.error(
        `[startup] ${capability} provider credentials contain invalid JSON/properties.`,
      );
      process.exit(1);
    }
  }
}
const env = (key) => process.env[key]?.trim() || undefined;
try {
  const portals = getPortalConfiguration(process.env);
  if (portals) {
    const authOrigin = env("BETTER_AUTH_URL");
    if (!authOrigin || new URL(authOrigin).origin !== `https://${portals.hosts.marketplace}`) {
      throw new Error(
        "BETTER_AUTH_URL must be the canonical HTTPS marketplace origin when portal routing is active",
      );
    }
  }
} catch (error) {
  console.error(`[startup] portal configuration invalid: ${error.message}`);
  process.exit(1);
}
// Executive Face + Passphrase is opt-in and MUST fail closed if the vetted
// server-side matching/PAD engine is not configured. Never enable mock scoring.
if (env("ELEMARKET_EXEC_FACE_ENABLED") === "1") {
  const url = env("EIDE_EXEC_FACE_ENGINE_URL") || "";
  const key = env("EIDE_EXEC_FACE_ENGINE_SECRET") || "";
  const policy = env("EIDE_EXEC_FACE_ENGINE_POLICY_ID") || "";
  let safe = false;
  try {
    const parsed = new URL(url);
    safe =
      parsed.pathname === "/v1/verify" &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password &&
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" && ["127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)));
  } catch {
    /* bad engine URL */
  }
  if (
    !getPortalConfiguration(process.env) ||
    !safe ||
    key.length < 32 ||
    !/^[a-zA-Z0-9_.:-]{8,128}$/.test(policy)
  ) {
    console.error(
      "[startup] executive face login requires 5-portal host routing, a valid private evaluator URL, EIDE_EXEC_FACE_ENGINE_SECRET of at least 32 characters, and EIDE_EXEC_FACE_ENGINE_POLICY_ID.",
    );
    process.exit(1);
  }
}
const explicitEnvironment = (env("ELEMARKET_ENV") || "").toLowerCase();
const production =
  process.argv.includes("--require-shared") ||
  explicitEnvironment === "production" ||
  explicitEnvironment === "staging" ||
  Boolean(env("VERCEL") || process.env.NODE_ENV === "production") ||
  Boolean(env("DATABASE_URL"));
if (production && !["production", "staging"].includes(explicitEnvironment)) {
  console.error(
    "[startup] ELEMARKET_ENV must be explicitly set to production or staging for a shared deployment.",
  );
  process.exit(1);
}

if (!production) {
  console.log("[startup] local/preview environment — production secret validation skipped.");
  process.exit(0);
}

if (
  env("ELEMARKET_TRUST_PROXY") !== "1" ||
  env("ELEMARKET_PROXY_OVERWRITES_FORWARDED_FOR") !== "1"
) {
  console.error(
    "[startup] shared deployment requires an explicitly trusted proxy that overwrites forwarded client IP headers.",
  );
  process.exit(1);
}

if (!env("BETTER_AUTH_IP_HEADER") && !env("BETTER_AUTH_TRUSTED_PROXIES")) {
  console.error(
    "[startup] trusted proxy mode requires BETTER_AUTH_IP_HEADER or BETTER_AUTH_TRUSTED_PROXIES.",
  );
  process.exit(1);
}
if (env("ELEMARKET_ENABLE_PREVIEW_SETTLEMENT") === "1") {
  console.error("[startup] preview settlement is forbidden in shared environments.");
  process.exit(1);
}

for (const [capability, variable] of [
  ["email", "ELEMARKET_EMAIL_PROVIDER"],
  ["otp", "ELEMARKET_OTP_PROVIDER"],
  ["storage", "ELEMARKET_STORAGE_PROVIDER"],
  ["location", "ELEMARKET_LOCATION_PROVIDER"],
  ["push", "ELEMARKET_PUSH_PROVIDER"],
]) {
  if (env(variable)) validateProviderCapability(capability, variable);
}
if (env("ELEMARKET_KYB_PROVIDER")) validateProviderCapability("kyb", "ELEMARKET_KYB_PROVIDER");
const delivery = env("ELEMARKET_DELIVERY_PROVIDER")?.toLowerCase();
if (delivery) {
  if (!/^[a-z0-9_-]{2,64}$/.test(delivery) || delivery === "preview") {
    console.error("[startup] marketplace requires a real delivery provider.");
    process.exit(1);
  }
  const deliveryPrefix = `ELEMARKET_DELIVERY_${delivery.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  if (!env(`${deliveryPrefix}_ENDPOINT`) || !env(`${deliveryPrefix}_SECRET`)) {
    console.error("[startup] delivery quote endpoint and credentials are required.");
    process.exit(1);
  }
  try {
    if (new URL(env(`${deliveryPrefix}_ENDPOINT`)).protocol !== "https:") throw new Error();
  } catch {
    console.error("[startup] delivery endpoint must use HTTPS.");
    process.exit(1);
  }
}
const paymentProviders = (env("ELEMARKET_LAUNCH_PAYMENT_PROVIDERS") || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
for (const provider of paymentProviders) {
  if (!/^[a-z0-9_-]{2,64}$/.test(provider) || provider.startsWith("preview")) {
    console.error("[startup] invalid launch payment provider.");
    process.exit(1);
  }
  const prefix = `ELEMARKET_PAYMENT_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  if (!env(`${prefix}_SECRET`)) {
    console.error(`[startup] missing ${prefix}_SECRET.`);
    process.exit(1);
  }
  const driver = env(`${prefix}_DRIVER`) || "http";
  if (driver === "http") {
    if (!env(`${prefix}_ENDPOINT`) || env(`${prefix}_IDEMPOTENT_INITIALIZATION`) !== "true") {
      console.error(
        "[startup] HTTP payment providers require an endpoint and verified idempotent initialization.",
      );
      process.exit(1);
    }
    try {
      if (new URL(env(`${prefix}_ENDPOINT`)).protocol !== "https:") throw new Error();
    } catch {
      console.error("[startup] payment endpoint must use HTTPS.");
      process.exit(1);
    }
  } else {
    const module = env(`ELEMARKET_PAYMENT_DRIVER_${driver.toUpperCase()}_MODULE`);
    if (
      !module ||
      !(env("ELEMARKET_PAYMENT_ALLOWED_MODULES") || "")
        .split(",")
        .map((v) => v.trim())
        .includes(module)
    ) {
      console.error("[startup] payment driver module is not configured and allowlisted.");
      process.exit(1);
    }
  }
}

const required = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CRON_SECRET",
  "ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY",
  "ELEMARKET_FINANCING_DATA_ENCRYPTION_KEY",
  "ELEMARKET_ENTERPRISE_SYNC_SECRET",
];
const missing = required.filter((key) => !env(key));
if (missing.length) {
  console.error(
    `[startup] missing required production environment variables: ${missing.join(", ")}`,
  );
  process.exit(1);
}
for (const key of ["CRON_SECRET", "ELEMARKET_ENTERPRISE_SYNC_SECRET"]) {
  if (env(key).length < 32) {
    console.error(`[startup] ${key} must be at least 32 characters.`);
    process.exit(1);
  }
}
const redisUrl = env("REDIS_URL");
let redisInfo;
try {
  redisInfo = redisUrl ? new URL(redisUrl) : null;
} catch {
  console.error("[startup] REDIS_URL is invalid; check its scheme, host and URL-encoded credentials.");
  process.exit(1);
}
const redisScheme = redisInfo?.protocol ?? null;
if (redisUrl && !["https:", "redis:", "rediss:"].includes(redisScheme)) {
  console.error("[startup] REDIS_URL must use https://, redis://, or rediss://.");
  process.exit(1);
}
if (redisScheme === "https:" && !env("REDIS_HTTP_TOKEN")) {
  console.error(
    "[startup] REDIS_HTTP_TOKEN is required when REDIS_URL is an HTTPS Redis endpoint.",
  );
  process.exit(1);
}
if (redisScheme === "redis:" || redisScheme === "rediss:") {
  // Native Redis authentication comes from URL userinfo or REDIS_USERNAME/REDIS_PASSWORD.
  const info = redisInfo;
  if (!info.password && !env("REDIS_PASSWORD")) {
    console.error(
      "[startup] Native REDIS_URL requires credentials in the URL userinfo or REDIS_PASSWORD.",
    );
    process.exit(1);
  }
}
const merchantEncryptionKey = env("ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY");
if (!merchantEncryptionKey) {
  console.error(
    "[startup] ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY is required in production for merchant compliance data encryption.",
  );
  process.exit(1);
}
const keyBytes = /^[0-9a-fA-F]{64}$/.test(merchantEncryptionKey)
  ? 32
  : Buffer.from(merchantEncryptionKey, "base64url").length;
if (keyBytes !== 32) {
  console.error("[startup] ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY must encode exactly 32 bytes.");
  process.exit(1);
}

const previousEncryptionKey = env("ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY_PREVIOUS");
if (previousEncryptionKey) {
  const previousBytes = /^[0-9a-fA-F]{64}$/.test(previousEncryptionKey)
    ? 32
    : Buffer.from(previousEncryptionKey, "base64url").length;
  if (previousBytes !== 32) {
    console.error(
      "[startup] ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY_PREVIOUS must encode exactly 32 bytes.",
    );
    process.exit(1);
  }
}

const financingEncryptionKey = env("ELEMARKET_FINANCING_DATA_ENCRYPTION_KEY");
if (!financingEncryptionKey) {
  console.error(
    "[startup] ELEMARKET_FINANCING_DATA_ENCRYPTION_KEY is required in production for financing application data encryption.",
  );
  process.exit(1);
}
const financingKeyBytes = /^[0-9a-fA-F]{64}$/.test(financingEncryptionKey)
  ? 32
  : Buffer.from(financingEncryptionKey, "base64url").length;
if (financingKeyBytes !== 32) {
  console.error("[startup] ELEMARKET_FINANCING_DATA_ENCRYPTION_KEY must encode exactly 32 bytes.");
  process.exit(1);
}
const previousFinancingEncryptionKey = env("ELEMARKET_FINANCING_DATA_ENCRYPTION_KEY_PREVIOUS");
if (previousFinancingEncryptionKey) {
  const previousFinancingBytes = /^[0-9a-fA-F]{64}$/.test(previousFinancingEncryptionKey)
    ? 32
    : Buffer.from(previousFinancingEncryptionKey, "base64url").length;
  if (previousFinancingBytes !== 32) {
    console.error(
      "[startup] ELEMARKET_FINANCING_DATA_ENCRYPTION_KEY_PREVIOUS must encode exactly 32 bytes.",
    );
    process.exit(1);
  }
}

const secret = env("BETTER_AUTH_SECRET");
if (!secret || secret.length < 32) {
  console.error("[startup] BETTER_AUTH_SECRET must be at least 32 characters in production.");
  process.exit(1);
}

const authUrl = env("BETTER_AUTH_URL");
try {
  const url = new URL(authUrl);
  if (url.protocol !== "https:") throw new Error("must use HTTPS");
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("must not point to loopback");
} catch (error) {
  console.error(
    `[startup] BETTER_AUTH_URL is invalid for production: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

// Authentication is always enabled; the obsolete VITE_AUTH_ENABLED switch is ignored.

if (env("ELEMARKET_PUBLIC_URL")) {
  const publicUrl = env("ELEMARKET_PUBLIC_URL");
  try {
    const url = new URL(publicUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.port && url.port !== "443") ||
      url.origin !== new URL(authUrl).origin
    )
      throw new Error("ELEMARKET_PUBLIC_URL must be the canonical HTTPS marketplace origin");
  } catch (error) {
    console.error(
      `[startup] ELEMARKET_PUBLIC_URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (production && env("SEARCH_CURSOR_SECRET") && env("SEARCH_CURSOR_SECRET").length < 32) {
  console.error("[startup] SEARCH_CURSOR_SECRET must be at least 32 characters in production.");
  process.exit(1);
}
console.log("[startup] production environment validation passed.");
