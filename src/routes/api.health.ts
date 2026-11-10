import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { structuredLog } from "@/lib/observability/logger.server";
import { safeErrorFields } from "@/lib/observability/safe-error.mjs";
import { redisCommand } from "@/lib/security/redis-rate-limit.server";

export type HealthChecks = { database: "ok" | "down"; cache: "ok" | "degraded" | "unconfigured" };

// Successful probes are shared for a short interval. A failed database probe is
// not cached, so a recovered database is visible on the next check.
let cached: { until: number; probe: Promise<HealthChecks> } | undefined;

async function probeReadiness(): Promise<HealthChecks> {
  const checks: HealthChecks = { database: "down", cache: "unconfigured" };
  try {
    const sql = await getSql();
    await sql.query("select 1 as ok");
    checks.database = "ok";
  } catch (error) {
    structuredLog("error", "health.database_failed", { metadata: safeErrorFields(error) });
    return checks;
  }
  const redis = process.env.REDIS_URL?.trim();
  if (redis?.startsWith("redis://") || redis?.startsWith("rediss://")) {
    try {
      if (await redisCommand(redis, ["PING"]) !== "PONG") throw new Error("Invalid cache response");
      checks.cache = "ok";
    } catch (error) {
      checks.cache = "degraded";
      structuredLog("warn", "health.cache_failed", { metadata: safeErrorFields(error) });
    }
  }
  return checks;
}

function health(): Promise<HealthChecks> {
  const now = Date.now();
  if (cached && now < cached.until) return cached.probe;
  const probe = probeReadiness().then((checks) => {
    if (checks.database !== "ok") cached = undefined;
    return checks;
  });
  cached = { until: now + 10_000, probe };
  return probe;
}

export const Route = createFileRoute("/api/health")({
  server: { handlers: { GET: async () => {
    const checks = await health();
    const ok = checks.database === "ok";
    return Response.json({ ok, checks }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
  } } },
});
