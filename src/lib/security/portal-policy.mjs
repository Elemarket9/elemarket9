/**
 * Host-bound portal policy for ELEMARKET's single modular monolith.
 * Non-secret hostnames are configuration. Authorisation is always server-side.
 * This module deliberately has no browser/framework dependencies for testing.
 */
import { isIP } from "node:net";

const portalVariables = Object.freeze({
  marketplace: "ELEMARKET_DOMAIN",
  executive: "ELEMARKET_EXECUTIVE_HOST",
  staff: "ELEMARKET_STAFF_HOST",
  seller: "ELEMARKET_SELLER_HOST",
  provider: "ELEMARKET_PROVIDER_HOST",
});

/** @param {NodeJS.ProcessEnv} [env] */
export function portalRoutingEnabled(env = process.env) {
  return env.ELEMARKET_PORTAL_HOST_ROUTING === "1";
}

/** Reject IPs, schemes, wildcard hostnames, credentials, and host:port in config. */
/** @param {string | null | undefined} raw */
export function normalizedPortalHostname(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (isIP(value) || /^\d+\.\d+\.\d+\.\d+$/.test(value)) return null;
  if (value.length < 4 || value.length > 253 || !/^[a-z0-9.-]+$/.test(value) ||
      value.includes("..") || /(^|\.)-|-($|\.)/.test(value) ||
      value.split(".").some(part => part.length > 63) || !value.includes(".")) return null;
  return value;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function getPortalConfiguration(env = process.env) {
  if (!portalRoutingEnabled(env)) return null;
  /** @type {Record<string, string>} */
  const hosts = {};
  for (const [portal, variable] of Object.entries(portalVariables)) {
    const host = normalizedPortalHostname(env[variable]);
    if (!host) throw new Error(`Portal routing requires a valid ${variable} hostname`);
    hosts[portal] = host;
  }
  if (new Set(Object.values(hosts)).size !== Object.keys(hosts).length) {
    throw new Error("Portal hostnames must be distinct");
  }
  const executiveUserId = (env.ELEMARKET_EXECUTIVE_USER_ID ?? "").trim();
  if (!executiveUserId || executiveUserId.length > 255 || /[\s]/.test(executiveUserId)) {
    throw new Error("Portal routing requires ELEMARKET_EXECUTIVE_USER_ID (verified database user ID)");
  }
  return {hosts, executiveUserId};
}

/** @param {string | null | undefined} rawHost
 * @param {NodeJS.ProcessEnv} [env]
 */
export function portalFromRequestHost(rawHost, env = process.env) {
  const config = getPortalConfiguration(env);
  if (!config) return "legacy";
  if (typeof rawHost !== "string") return null;
  // Incoming request header may contain a port (local proxy tests).
  const name = normalizedPortalHostname(rawHost.trim().replace(/:\d+$/, ""));
  if (!name) return null;
  return Object.entries(config.hosts).find(([, host]) => host === name)?.[0] ?? null;
}

/** A specific, provisioned account, not merely any account with the owner role. */
/** @param {{staffRole: string | null | undefined, userId: string, requestHost: string | null | undefined, env?: NodeJS.ProcessEnv}} args */
export function isPermittedAdminPrincipal({staffRole, userId, requestHost, env = process.env}) {
  const config = getPortalConfiguration(env);
  if (!config) return Boolean(staffRole);
  const portal = portalFromRequestHost(requestHost, env);
  if (staffRole === "owner") return portal === "executive" && userId === config.executiveUserId;
  return Boolean(staffRole) && portal === "staff";
}

/** @param {string | null | undefined} requestHost
 * @param {NodeJS.ProcessEnv} [env]
 */
export function adminPortalKind(requestHost, env = process.env) {
  const portal = portalFromRequestHost(requestHost, env);
  return portal === "executive" || portal === "staff" ? portal : "legacy";
}
