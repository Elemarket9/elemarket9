import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { portalAllowsPath } from "@/lib/security/portal-policy.mjs";
import { securityHeaders } from "@/lib/security/headers";

function createCspNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

const portalMiddleware = createMiddleware().server(({ request, next }) => {
  if (!portalAllowsPath(request.headers.get("host"), new URL(request.url).pathname)) {
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return next();
});

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

const securityMiddleware = createMiddleware().server(async ({ next }) => {
  const cspNonce = createCspNonce();
  const result = await next({ context: { cspNonce } });
  // A loader error can replace Start's response headers. Apply the nonce to
  // the final response so its SSR bootstrap remains permitted by CSP too.
  const headers = new Headers(result.response.headers);
  const configuredHeaders = securityHeaders({ production: true, nonce: cspNonce });

  for (const [key, value] of Object.entries(configuredHeaders)) headers.set(key, value);
  return { ...result, response: new Response(result.response.body, {
    status: result.response.status, statusText: result.response.statusText, headers,
  }) };
});

export const startInstance = createStart(() => ({
  requestMiddleware: [portalMiddleware, csrfMiddleware, securityMiddleware],
}));
