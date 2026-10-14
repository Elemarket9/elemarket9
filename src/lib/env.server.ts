export function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

export type ElemarketEnvironment = "development" | "preview" | "staging" | "production";

export function getElemarketEnvironment(): ElemarketEnvironment {
  const explicit = env("ELEMARKET_ENV")?.toLowerCase();
  if (explicit === "development" || explicit === "preview" || explicit === "staging" || explicit === "production") {
    return explicit;
  }
  if (process.env.NODE_ENV === "production") return "production";
  return "development";
}

export function isWorkspacePreview(): boolean {
  const current = getElemarketEnvironment();
  return current === "development" || current === "preview";
}

export function isSharedEnvironment(): boolean {
  const current = getElemarketEnvironment();
  return current === "staging" || current === "production";
}

/** Production/shared deployments require durable Postgres and explicit auth configuration. */
export function assertSharedInfrastructure() {
  if (!isSharedEnvironment()) return;
  if (!env("DATABASE_URL")) throw new Error("Shared environments require DATABASE_URL; refusing embedded PGlite.");
  if (!env("ELEMARKET_ENV")) throw new Error("Shared environments require ELEMARKET_ENV=staging or production; refusing ambiguous deployment mode.");
  // If rate limiting derives the client IP from forwarded headers, the edge
  // proxy must overwrite (not append to) the header. Requiring an explicit
  // deployment contract prevents a client-controlled X-Forwarded-For value
  // from becoming the rate-limit identity.
  if (env("ELEMARKET_TRUST_PROXY") === "1" && env("ELEMARKET_PROXY_OVERWRITES_FORWARDED_FOR") !== "1") {
    throw new Error("ELEMARKET_TRUST_PROXY=1 requires ELEMARKET_PROXY_OVERWRITES_FORWARDED_FOR=1; refusing spoofable forwarded-IP rate limiting.");
  }
}

assertSharedInfrastructure();
