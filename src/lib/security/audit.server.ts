import { getSql } from "@/lib/db";

/** Durable audit bridge for server-only administration flows. */
export async function recordAuditEvent(input: {
  eventType: string;
  resourceType: string;
  resourceId: string;
  actorUserId: string;
  actorRole: string;
  metadata?: Record<string, unknown>;
}) {
  const sql = await getSql();
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
    input.eventType,
    input.resourceType,
    input.resourceId,
    input.actorUserId,
    input.actorRole,
    null,
    "success",
    JSON.stringify(input.metadata ?? {}),
  ]);
}
