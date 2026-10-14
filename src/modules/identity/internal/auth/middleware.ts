import { createMiddleware } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";

/**
 * Authenticate the current server-function request once and expose only the
 * verified principal identity to downstream handlers. Authorization helpers
 * consume this verified user id; no client-supplied bearer token is forwarded.
 */
export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const { assertSameSiteRequest } = await import("./isolation.server");
  const { requireUserId } = await import("./verify.server");
  const request = getRequest();
  const authorization = request?.headers.get("authorization") ?? "";
  const bearerToken = /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1];
  // Browser sessions remain protected by Fetch Metadata / SameSite controls.
  // Native clients authenticate with Better Auth's bearer plugin and therefore
  // do not carry browser Fetch-Metadata headers; bearer requests are explicitly
  // treated as non-cookie API calls.
  if (!bearerToken) assertSameSiteRequest();
  const userId = await requireUserId(bearerToken);
  setResponseHeader("Cache-Control", "private, no-store");
  setResponseHeader("Vary", "Cookie, Authorization");
  return next({ context: { userId } });
});
export type AuthenticatedFunctionContext = {
  userId?: string;
};

export function getAuthenticatedUserId(context: AuthenticatedFunctionContext): string {
  if (!context.userId) throw new Error("Unauthenticated");
  return context.userId;
}

