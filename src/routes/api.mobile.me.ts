import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/modules/identity/public/auth/server";
import { getSql } from "@/lib/db";
import { enforceRateLimit, rateLimitResponse } from "@/lib/security/rate-limit.server";

async function session(request: Request) {
  return auth.api.getSession({ headers: request.headers });
}

export const Route = createFileRoute("/api/mobile/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const current = await session(request);
        if (!current?.user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
        try { await enforceRateLimit("mobile-me", { windowSeconds: 60, maxRequests: 60, subject: current.user.id }); }
        catch (error) { const limited = rateLimitResponse(error); if (limited) return limited; throw error; }
        const sql = await getSql();
        const rows = await sql.query<{ name: string; phone: string | null; address: string | null; email: string }>(
          `select coalesce(p.name,u.name) as name,p.phone,p.address,u.email
             from "user" u left join profiles p on p.user_id=u.id
            where u.id=$1 limit 1`,
          [current.user.id],
        );
        if (!rows[0]) return Response.json({ error: "Account not found" }, { status: 404, headers: { "cache-control": "no-store" } });
        return Response.json({ user: { id: current.user.id, email: rows[0].email }, profile: rows[0] }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
