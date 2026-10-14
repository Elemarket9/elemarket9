import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { getResponseHeaders, setResponseHeaders } from "@tanstack/react-start/server";
import { securityHeaders } from "@/lib/security/headers";

function createCspNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

const securityMiddleware = createMiddleware().server(({ next }) => {
  const cspNonce = createCspNonce();
  const headers = getResponseHeaders();
  const configuredHeaders = securityHeaders({ production: true, nonce: cspNonce });

  for (const [key, value] of Object.entries(configuredHeaders)) headers.set(key, value);
  setResponseHeaders(headers);

  return next({
    context: { cspNonce },
  });
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, securityMiddleware],
}));
