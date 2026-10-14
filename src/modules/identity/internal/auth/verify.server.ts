import { getRequest } from "@tanstack/react-start/server";
import { auth, authConfigured, readSessionToken } from "./server";

/**
 * Server-side session resolution (server-only).
 *
 * Because this app runs its OWN Better Auth at same-origin `/api/auth/*`, the
 * session cookie is sent with every request to this app — server functions AND
 * SSR loaders included. So we resolve the user straight from the request cookies
 * via `auth.api.getSession` (no client-minted JWT needed). Never trust a
 * client-supplied user id — only the result of this verification.
 */

/** True when a real database is configured server-side. */
const databaseConfigured = Boolean(process.env.DATABASE_URL?.trim());
const localDevelopmentFallbackAllowed =
  process.env.ELEMARKET_ENV === "development" && !databaseConfigured;

/** Re-export so callers can branch on it without importing `server.ts`. */
export { authConfigured };

if (databaseConfigured && !authConfigured) {
  console.error(
    "[auth] DATABASE_URL is set but auth is disabled (VITE_AUTH_ENABLED=false) " +
      "— requireUserId() will reject every request (fail closed) rather than " +
      "share one dev user on a real database.",
  );
}

/** Dev fallback user id, used only when auth is disabled (VITE_AUTH_ENABLED=false). */
export const DEV_USER_ID = "dev-user";

/**
 * Thrown by `requireUserId` when the caller has no valid session. Carries
 * `status: 401`; the message is a stable contract — match
 * `err.message === "Unauthorized"` client-side to send the visitor to sign-in.
 */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export type VerifiedUser = { id: string; email: string | null };

/**
 * Resolve the signed-in user from the current request, or `null` when auth isn't
 * configured / nobody is signed in. Safe to call from server functions and SSR
 * loaders.
 *
 * `bearerToken` is for the LIVE PREVIEW: the app runs in a partitioned iframe
 * whose cookies don't reach the server, so `authMiddleware` forwards the session
 * as a bearer token, which we present as `Authorization: Bearer …` (the `bearer`
 * plugin resolves it). When deployed no token is passed and the cookie is used.
 */
export async function getSessionUser(
  bearerToken?: string,
): Promise<VerifiedUser | null> {
  if (!authConfigured) return null;
  void bearerToken;
  const request = getRequest();
  if (!request) return null;
  const headers = request.headers;
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email ?? null };
}

/**
 * Resolve the current user id for a server function, or throw when unauthorized.
 * Prefer `authMiddleware` (`./middleware`), which calls this for you.
 * - Auth enabled -> the verified session user id; throws
 *   `UnauthorizedError` when signed out. Works in the sandbox preview too (real
 *   sign-in via the baked preview client).
 * - Auth disabled (`VITE_AUTH_ENABLED=false`) + `DATABASE_URL` set -> throw (fail
 *   closed): one shared dev user on a real database would let every visitor
 *   read/write everyone's rows.
 * - Auth disabled + no database -> the shared dev user id.
 */
export async function requireUserId(bearerToken?: string): Promise<string> {
  if (!authConfigured) {
    if (!localDevelopmentFallbackAllowed) {
      throw new Error(
        "Auth is disabled (VITE_AUTH_ENABLED=false) outside an isolated local development environment — " +
          "refusing the shared dev user fallback.",
      );
    }
    return DEV_USER_ID;
  }
  const user = await getSessionUser(bearerToken);
  if (!user) throw new UnauthorizedError();
  return user.id;
}

/**
 * Require a recently authenticated session for high-risk account actions.
 *
 * This deliberately checks the persisted session creation time rather than a
 * client-provided timestamp. The normal session may be refreshed for routine
 * browsing, but password/email changes and role-sensitive operations should
 * require a session created within the freshness window.
 */
export async function requireFreshSession(
  bearerToken?: string,
  maxAgeSeconds = 60 * 60,
): Promise<string> {
  // Resolve the session through Better Auth rather than reconstructing it from
  // the raw cookie/token. This keeps fresh-session checks aligned with the
  // same cookie, bearer, prefix, secure-cookie and session semantics used by
  // requireUserId()/getSessionUser().
  const request = getRequest();
  if (!request) throw new UnauthorizedError();
  void bearerToken;

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user || !session.session) throw new UnauthorizedError();

  const createdAt = Date.parse(String(session.session.createdAt));
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > maxAgeSeconds * 1000) {
    throw new Error("Fresh authentication required");
  }
  return session.user.id;
}


export function readCurrentSessionToken(): string | null {
  return readRequestBearerToken() || readSessionCookieToken();
}

function readRequestBearerToken(): string | null {
  try {
    const request = getRequest();
    const value = request?.headers.get("authorization") ?? "";
    const match = /^Bearer\s+([^\s]+)$/i.exec(value.trim());
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function readSessionCookieToken(): string | null {
  try {
    return readSessionToken();
  } catch {
    return null;
  }
}
