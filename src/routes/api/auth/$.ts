import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/modules/identity/public/auth/server";
import { portalAllowsAuthRequest } from "@/lib/security/portal-policy.mjs";

function handleAuth(request: Request) {
  if (!portalAllowsAuthRequest(request)) {
    return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  return auth.handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuth(request),
      POST: ({ request }) => handleAuth(request),
    },
  },
});
