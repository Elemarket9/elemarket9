import { getRequest } from "@tanstack/react-start/server";
import { portalFromRequestHost, portalRoutingEnabled, isPermittedAdminPrincipal, adminPortalKind } from "./portal-policy.mjs";

/** Request Host is accepted only behind the deployment's allowlisted Caddy vhost.
 * Never trust X-Forwarded-Host supplied by a client. The app is not published
 * directly and the reverse proxy overwrites forwarded client IP headers.
 */
export function currentPortalHost(): string | null {
  const request = getRequest();
  return request?.headers.get("host") ?? null;
}
export function assertAdminPortalPrincipal(staffRole: string, userId: string): void {
  if (!isPermittedAdminPrincipal({ staffRole, userId, requestHost: currentPortalHost() })) {
    throw new Error("Forbidden: wrong administration portal or executive identity");
  }
}
export function isAdminPortalPrincipal(staffRole: string, userId: string): boolean {
  return isPermittedAdminPrincipal({ staffRole, userId, requestHost: currentPortalHost() });
}
export function currentAdminPortalKind(): "executive" | "staff" | "legacy" {
  return adminPortalKind(currentPortalHost());
}

/** Hard request-host assertion for portal-only server functions.
 * Session/organization membership checks MUST still run afterwards. */
export function assertPortalOperationHost(portal: "seller" | "provider"): void {
  if (!portalRoutingEnabled()) return;
  if (portalFromRequestHost(currentPortalHost()) !== portal) {
    throw new Error("Forbidden: wrong portal origin");
  }
}
