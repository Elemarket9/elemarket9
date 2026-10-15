/**
 * Self-hosted Better Auth for ELEMARKET.
 * Authentication is local to this application; no workspace/preview broker is required.
 */
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { bearer } from "better-auth/plugins";
import { twoFactor } from "better-auth/plugins";
import { getCookie } from "@tanstack/react-start/server";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { ensureDbReady, getPglite } from "../../../../lib/db";
import { emailAndPasswordEnabled } from "./email-password";
import { sendAuthEmail } from "./email.server";
import { pgliteDialect } from "./pglite-dialect";
import { getElemarketEnvironment } from "../../../../lib/env.server";
import { getPortalConfiguration } from "../../../../lib/security/portal-policy.mjs";
import { executiveBiometric } from "./executive/plugin.server";

void ensureDbReady();
const env = (key: string) => process.env[key]?.trim() || undefined;
const databaseUrl = env("DATABASE_URL");
const deployed = getElemarketEnvironment() === "production" || getElemarketEnvironment() === "staging";
if (deployed && !databaseUrl) throw new Error("Production requires DATABASE_URL for authentication persistence");
if (deployed && !env("BETTER_AUTH_SECRET")) throw new Error("Production requires BETTER_AUTH_SECRET");
export const authConfigured = true;
const explicitBaseURL = env("BETTER_AUTH_URL");
const configuredTrustedOrigins = (env("BETTER_AUTH_TRUSTED_ORIGINS") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (deployed && !explicitBaseURL) {
  throw new Error("Shared environments require BETTER_AUTH_URL; refusing request-derived authentication origin.");
}
if (deployed && explicitBaseURL && !/^https:\/\//i.test(explicitBaseURL)) {
  throw new Error("Shared environments require BETTER_AUTH_URL to use HTTPS.");
}
for (const origin of configuredTrustedOrigins) {
  if (deployed && !/^https:\/\//i.test(origin)) {
    throw new Error("BETTER_AUTH_TRUSTED_ORIGINS must contain HTTPS origins in shared environments.");
  }
}
const portalConfiguration = getPortalConfiguration(process.env);
const portalOrigins = portalConfiguration ? Object.values(portalConfiguration.hosts).map((hostname) => `https://${hostname}`) : [];
const localOrigins = ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"];
const baseURL = explicitBaseURL ?? "http://localhost:8080";
const trustedOrigins: string[] = explicitBaseURL
  ? [...new Set([explicitBaseURL, ...portalOrigins, ...configuredTrustedOrigins])]
  : [...new Set([...localOrigins, ...portalOrigins, ...configuredTrustedOrigins])];
const authIpHeader = env("BETTER_AUTH_IP_HEADER");
const trustedProxyList = (env("BETTER_AUTH_TRUSTED_PROXIES") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (deployed && env("ELEMARKET_TRUST_PROXY") === "1" && !authIpHeader && trustedProxyList.length === 0) {
  throw new Error("Trusted proxy mode requires BETTER_AUTH_IP_HEADER or BETTER_AUTH_TRUSTED_PROXIES for authentication rate-limit identity.");
}
const database = databaseUrl ? new Pool({ connectionString: databaseUrl, allowExitOnIdle: true }) : { dialect: pgliteDialect(() => getPglite()), type: "postgres" as const };
const globalAuthRef = globalThis as typeof globalThis & { __elemarketAuthSecret__?: string };
function localAuthSecret(): string {
  globalAuthRef.__elemarketAuthSecret__ ??= randomBytes(32).toString("hex");
  return globalAuthRef.__elemarketAuthSecret__;
}
export const auth = betterAuth({
  // In 1.7.x Better Auth supports a request-specific, allowlisted baseURL.
  // A static marketplace baseURL would send seller/provider 2FA and verification
  // redirects to the wrong origin. No wildcard trust or shared cookies.
  baseURL: portalConfiguration
    ? { allowedHosts: Object.values(portalConfiguration.hosts), protocol: "https" as const }
    : baseURL,
  secret: env("BETTER_AUTH_SECRET") ?? localAuthSecret(),
  database,
  trustedOrigins,
  emailAndPassword: {
    enabled: emailAndPasswordEnabled,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendAuthEmail({ kind: "password_reset", to: user.email, name: user.name, url });
    },
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 3600,
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendAuthEmail({ kind: "verification", to: user.email, name: user.name, url });
    },
    sendOnSignUp: false,
    sendOnSignIn: false,
    expiresIn: 3600,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: "database",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
      "/forget-password": { window: 60, max: 5 },
      "/change-password": { window: 60, max: 5 },
      "/change-email": { window: 60, max: 5 },
      "/executive/face-sign-in": { window: 60, max: 5 },
    },
  },
  advanced: {
    // Keep CSRF and origin checks enabled explicitly; these must never become
    // accidental configuration regressions during future framework upgrades.
    disableCSRFCheck: false,
    disableOriginCheck: false,
    ipAddress: {
      ...(authIpHeader ? { ipAddressHeaders: [authIpHeader] } : {}),
      ...(trustedProxyList.length ? { trustedProxies: trustedProxyList } : {}),
    },
    // Keep authentication cookies unreadable to browser JavaScript and secure on
    // every shared deployment. SameSite=Lax is Better Auth's safe default and
    // preserves normal top-level navigation/redirect flows.
    useSecureCookies: deployed,
    defaultCookieAttributes: {
      httpOnly: true,
      secure: deployed,
      sameSite: "lax",
      path: "/",
    },
    cookiePrefix: "elemarket",
  },
  session: {
    cookieCache: { enabled: false },
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    freshAge: 60 * 5,
  },
  appName: "ELEMARKET",
  plugins: [
    bearer(),
    executiveBiometric(),
    twoFactor({
      issuer: "ELEMARKET",
      skipVerificationOnEnable: false,
      accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 15 * 60 },
      backupCodeOptions: { amount: 10, length: 12 },
    }),
    // Better Auth requires the TanStack Start cookie adapter to be last so it
    // can capture Set-Cookie headers produced by authentication plugins,
    // including the two-factor challenge and post-verification session.
    tanstackStartCookies(),
  ],
});
export function readSessionToken(): string | null {
  return getCookie("elemarket.session_token") ?? getCookie("__Secure-elemarket.session_token") ?? getCookie("__Host-elemarket.session_token") ?? null;
}
