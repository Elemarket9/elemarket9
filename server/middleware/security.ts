import { securityHeaders } from "../../src/lib/security/headers";

export default async function securityMiddleware(
  _event: { req: { headers: Headers } },
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const result = await next();
  if (!(result instanceof Response)) return result;
  const headers = new Headers(result.headers);
  for (const [key, value] of Object.entries(securityHeaders({ production: true }))) {
    // TanStack Start sets the request-specific CSP nonce before SSR. Preserve it
    // instead of replacing it after the rendered response is produced.
    if (key === "Content-Security-Policy" && headers.has(key)) continue;
    headers.set(key, value);
  }
  return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
}
