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

/** Re-export the authentication availability contract. */
export { authConfigured };

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
 * Request headers carry the verified cookie or native bearer session. The legacy
 * optional argument is retained for callers but cannot supply an identity.
 */
export async function getSessionUser(bearerToken?: string): Promise<VerifiedUser | null> {
  if (!authConfigured) return null;
  void bearerToken;
  const request = getRequest();
  if (!request) return null;
  const headers = request.headers;
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email ?? null };
}

/** Require a persisted, verified session in every environment. */
export async function requireUserId(bearerToken?: string): Promise<string> {
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
