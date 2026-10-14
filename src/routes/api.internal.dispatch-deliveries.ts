import { createFileRoute } from "@tanstack/react-router";
import { authorizeScheduledJobRequest } from "@/lib/security/internal-job-auth.server";
import { dispatchDeliveries } from "@/modules/logistics/public/dispatch.server";

export const Route = createFileRoute("/api/internal/dispatch-deliveries")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await authorizeScheduledJobRequest(request, process.env.CRON_SECRET)))
          return new Response("Unauthorized", { status: 401 });
        return Response.json(await dispatchDeliveries(), {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
