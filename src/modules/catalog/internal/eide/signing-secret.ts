import { randomBytes } from "node:crypto";

const ephemeralSecret = randomBytes(32).toString("hex");

type SecretEnv = {
  NODE_ENV?: string;
  ELEMARKET_ENV?: string;
  SEARCH_CURSOR_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
};

/**
 * Search cursors and exposure receipts. Production and staging must configure
 * a secret. Other environments get a process-local secret, never a value
 * checked into source.
 */
export function discoverySigningSecret(env: SecretEnv = process.env): string {
  const configured = env.SEARCH_CURSOR_SECRET?.trim() || env.BETTER_AUTH_SECRET?.trim() || "";
  const mode = (env.ELEMARKET_ENV ?? "").trim().toLowerCase();
  const shared = mode === "production" || mode === "staging" || env.NODE_ENV === "production";
  if (shared) {
    if (configured.length < 32) throw new Error("Search signing secret must contain at least 32 characters");
    return configured;
  }
  if (configured.length >= 32) return configured;
  if (configured) throw new Error("Search signing secret must contain at least 32 characters");
  return ephemeralSecret;
}
