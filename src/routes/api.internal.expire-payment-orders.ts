import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { getStorageProvider } from "@/lib/storage/registry.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { authorizeScheduledJobRequest } from "@/lib/security/internal-job-auth.server";

async function assertCronAuthorization(request: Request): Promise<void> {
  if (!(await authorizeScheduledJobRequest(request, process.env.CRON_SECRET, process.env.CRON_SECRET))) {
    throw new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  }
}

export const Route = createFileRoute("/api/internal/expire-payment-orders")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        await assertCronAuthorization(request);
        await enforceRateLimit("internal-expire-payment-orders", { identity: "subject", subject: "authenticated-scheduler", windowSeconds: 60, maxRequests: 6 });
        const sql = await getSql();
        const rows = await sql.query<{ count: number }>(
          `select expire_payment_pending_orders(100) as count`,
        );

        // Bound each invocation. Failed object deletion stays cleanup_pending and
        // is retried by a later cron invocation.
        const cleanupClaimToken = crypto.randomUUID();
        const stale = await sql.query<{ id: string; object_key: string }>(
          `update storage_upload_intents
              set status='cleanup_pending',
                  cleanup_claim_token=$1,
                  cleanup_claim_expires_at=now()+interval '2 minutes'
            where id in (
              select id
                from storage_upload_intents
               where status in ('authorized','verifying','rejected','cleanup_pending')
                 and (expires_at < now() or created_at < now() - interval '1 hour')
                 and (cleanup_claim_token is null or cleanup_claim_expires_at < now())
               order by created_at asc
               limit 100
               for update skip locked
            )
            returning id,object_key`,
          [cleanupClaimToken],
        );

        let uploadsCleaned = 0;
        if (stale.length) {
          const provider = getStorageProvider();
          for (const row of stale) {
            try {
              await provider.deleteObject(row.object_key);
              await sql.query(
                `update storage_upload_intents
                    set status='expired', cleanup_claim_token=null, cleanup_claim_expires_at=null
                  where id=$1 and status='cleanup_pending' and cleanup_claim_token=$2`,
                [row.id, cleanupClaimToken],
              );
              uploadsCleaned += 1;
            } catch {
              // Keep cleanup_pending so a later bounded cron run retries it.
            }
          }
        }

        return Response.json(
          { ok: true, expired: Number(rows[0]?.count ?? 0), uploadsCleaned },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
