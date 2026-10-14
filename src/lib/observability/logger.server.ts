import { getSql } from "@/lib/db";
import { fetchPinnedPublicHttps } from "@/lib/security/pinned-https.server";
import { getElemarketEnvironment } from "@/lib/env.server";

export type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = {
  requestId?: string;
  userId?: string;
  entityId?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

function safeJson(value: unknown) {
  try { return JSON.stringify(value); } catch { return JSON.stringify({ serializationError: true }); }
}

export function structuredLog(level: LogLevel, event: string, fields: LogFields = {}) {
  const record = { ts: new Date().toISOString(), service: "elemarket", level, event, ...fields };
  const line = safeJson(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export async function recordMetric(event: string, fields: LogFields = {}) {
  structuredLog("info", event, fields);
  try {
    const sql = await getSql();
    await sql.query(`select record_observability_event($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
      event, "info", fields.requestId ?? null, fields.userId ?? null, fields.entityId ?? null,
      fields.durationMs ?? null, JSON.stringify(fields.metadata ?? {}),
    ]);
    await sql.query(`select increment_observability_counter($1,1)`, [event]);
  } catch (error) {
    structuredLog("warn", "observability.write_failed", { metadata: { event, error: error instanceof Error ? error.message : String(error) } });
  }
}

/**
 * Provider-neutral error reporting. Structured log + optional HTTP sink.
 * The sink is deliberately generic (any webhook endpoint, e.g. an error
 * tracker ingest or ops channel) so observability stays vendor-neutral; it is
 * SSRF-guarded and must receive NO secrets, tokens, payment payloads or
 * customer PII — event name, error message and stack only.
 */
let errorSinkWarned = false;

export function captureError(event: string, error: unknown, fields: LogFields = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  structuredLog("error", event, {
    ...fields,
    metadata: { ...(fields.metadata ?? {}), error: message, ...(stack ? { stack } : {}) },
  });

  const webhook = process.env.ELEMARKET_ERROR_WEBHOOK_URL?.trim();
  if (!webhook) return;
  void (async () => {
    try {
      const endpoint = webhook;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        await fetchPinnedPublicHttps(endpoint, {
          method: "POST",
          
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            service: "elemarket",
            environment: getElemarketEnvironment(),
            timestamp: new Date().toISOString(),
            event,
            message,
            ...(stack ? { stack } : {}),
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (sinkError) {
      if (!errorSinkWarned) {
        errorSinkWarned = true;
        structuredLog("warn", "observability.error_sink_failed", {
          metadata: { error: sinkError instanceof Error ? sinkError.message : String(sinkError) },
        });
      }
    }
  })();
}
