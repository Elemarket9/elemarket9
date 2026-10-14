import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { getElemarketEnvironment } from "@/lib/env.server";
import { redisCommand } from "@/lib/security/redis-rate-limit.server";
import { structuredLog } from "@/lib/observability/logger.server";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const checks: Record<string, "ok" | "fail" | "skipped"> = {};
        const cache = process.env.REDIS_URL?.trim();

        try {
          const sql = await getSql();
          await sql.query("select 1 as ok");
          checks.database = "ok";
        } catch (error) {
          checks.database = "fail";
          structuredLog("error", "health.database_failed", { metadata: { error: error instanceof Error ? error.message : String(error) } });
        }

        // The cache is an optimization with a PostgreSQL fallback: a cache
        // failure degrades the deployment but does not make it unhealthy.
        if (cache?.startsWith("redis://") || cache?.startsWith("rediss://")) {
          try {
            const reply = await redisCommand(cache, ["PING"]);
            checks.cache = reply === "PONG" ? "ok" : "fail";
          } catch (error) {
            checks.cache = "fail";
            structuredLog("warn", "health.cache_failed", { metadata: { error: error instanceof Error ? error.message : String(error) } });
          }
        } else if (cache?.startsWith("https://")) {
          checks.cache = "skipped";
        } else {
          checks.cache = "skipped";
        }

        const degraded = Object.values(checks).includes("fail") && checks.database === "ok";
        const ok = checks.database === "ok";
        return Response.json(
          { ok, degraded, checks, environment: getElemarketEnvironment() },
          { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
