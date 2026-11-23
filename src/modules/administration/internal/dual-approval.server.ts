import { randomBytes } from "node:crypto";
import { getSql, withTransaction, type Sql } from "@/lib/db";

/**
 * Four-eyes (two-person) control for high-value staff money actions.
 *
 * Above the threshold, one administrator RECORDS the action and a different
 * administrator holding the same permission APPROVES it; only then does the
 * money move, under the approver's identity. The database refuses a
 * self-approval (admin_dual_approvals_four_eyes) even if this code is bypassed.
 *
 * Threshold: ELEMARKET_DUAL_APPROVAL_THRESHOLD_GHS (default 1000). Amounts
 * strictly above it need a second person. Set 0 to require it for every amount.
 */
export type DualApprovalAction = "order_refund" | "wallet_payout_resolution";
export type DualApprovalCapability = "admin.finance.refunds" | "admin.finance.payouts";

const DEFAULT_THRESHOLD = 1000;

export function dualApprovalThreshold(): number {
  const raw = process.env.ELEMARKET_DUAL_APPROVAL_THRESHOLD_GHS?.trim();
  if (!raw) return DEFAULT_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("ELEMARKET_DUAL_APPROVAL_THRESHOLD_GHS must be a non-negative number");
  return value;
}

export function requiresDualApproval(amount: number | string): boolean {
  const value = Number(amount);
  if (!Number.isFinite(value)) return true; // fail closed
  return Math.round(value * 100) > Math.round(dualApprovalThreshold() * 100);
}

export type DualApprovalRow = {
  id: string;
  action: DualApprovalAction;
  subject_id: string;
  amount: string;
  currency: string;
  payload: Record<string, unknown>;
  required_capability: DualApprovalCapability;
  requested_by: string;
  request_reason: string;
  status: string;
  expires_at: string;
};

export async function createDualApproval(sql: Sql, input: {
  action: DualApprovalAction;
  subjectId: string;
  amount: string;
  currency: string;
  payload: Record<string, unknown>;
  capability: DualApprovalCapability;
  requestedBy: string;
  reason: string;
}): Promise<{ approvalId: string }> {
  const id = `dap_${randomBytes(16).toString("hex")}`;
  // Expire stale requests for this subject first so an abandoned request does not block forever.
  await sql.query(
    `update admin_dual_approvals set status='expired' where action=$1 and subject_id=$2 and status='pending' and expires_at<=now()`,
    [input.action, input.subjectId],
  );
  // An approval whose execution never recorded an outcome (process died between
  // "approved" and the money call) must not block the subject forever. Retrying
  // is safe: refund preparation and payout resolution are idempotent per subject.
  await sql.query(
    `update admin_dual_approvals set status='failed', execution_error='Execution did not complete; superseded by a new request'
      where action=$1 and subject_id=$2 and status='approved' and decided_at <= now() - interval '1 hour'`,
    [input.action, input.subjectId],
  );
  const open = await sql.query<{ id: string }>(
    `select id from admin_dual_approvals where action=$1 and subject_id=$2 and status in ('pending','approved') limit 1`,
    [input.action, input.subjectId],
  );
  if (open[0]) throw new Error("This action is already waiting for a second approver");
  await sql.query(
    `insert into admin_dual_approvals(id,action,subject_id,amount,currency,payload,required_capability,requested_by,request_reason)
     values($1,$2,$3,$4::numeric,$5,$6::jsonb,$7,$8,$9)`,
    [id, input.action, input.subjectId, input.amount, input.currency, JSON.stringify(input.payload),
      input.capability, input.requestedBy, input.reason],
  );
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
    "admin.dual_approval.requested", "admin_dual_approval", id, input.requestedBy, "admin", null, "success",
    JSON.stringify({ action: input.action, subjectId: input.subjectId, amount: input.amount, currency: input.currency, reason: input.reason }),
  ]);
  return { approvalId: id };
}

/**
 * Record the second person's decision atomically. Returns the locked request
 * so the caller can execute an approval under the approver's own identity.
 */
export async function decideDualApproval(input: {
  approvalId: string;
  deciderId: string;
  decision: "approve" | "reject";
  note: string;
}): Promise<DualApprovalRow> {
  return withTransaction(async (sql) => {
    const rows = await sql.query<DualApprovalRow & { expired: boolean }>(
      `select id,action,subject_id,amount::text,currency,payload,required_capability,requested_by,request_reason,status,
              expires_at::text, (expires_at<=now()) as expired
         from admin_dual_approvals where id=$1 for update`,
      [input.approvalId],
    );
    const row = rows[0];
    if (!row) throw new Error("Approval request not found");
    if (row.status !== "pending") throw new Error("This request has already been decided");
    if (row.expired) {
      await sql.query(`update admin_dual_approvals set status='expired' where id=$1`, [row.id]);
      throw new Error("This request expired; ask for it to be submitted again");
    }
    if (row.requested_by === input.deciderId) throw new Error("A second administrator must approve this; you submitted it");
    if (input.decision === "approve") {
      // Also enforced by trigger admin_dual_approvals_independence (migration 0236).
      const [independent] = await sql.query<{ ok: boolean }>(
        `select admin_approver_is_independent($1,$2,$3) as ok`, [input.deciderId, row.requested_by, row.required_capability]);
      if (!independent?.ok) {
        throw new Error("You can't approve this: your approval role was given to you by the requester, or less than 7 days ago. Ask another administrator.");
      }
    }
    await sql.query(
      `update admin_dual_approvals set status=$2, decided_by=$3, decision_note=$4, decided_at=now() where id=$1`,
      [row.id, input.decision === "approve" ? "approved" : "rejected", input.deciderId, input.note],
    );
    await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
      `admin.dual_approval.${input.decision === "approve" ? "approved" : "rejected"}`, "admin_dual_approval", row.id,
      input.deciderId, "admin", null, "success",
      JSON.stringify({ action: row.action, subjectId: row.subject_id, amount: row.amount, requestedBy: row.requested_by, note: input.note }),
    ]);
    return { ...row, status: input.decision === "approve" ? "approved" : "rejected" };
  });
}

export async function recordDualApprovalOutcome(approvalId: string, outcome: { ok: true } | { ok: false; error: string }) {
  const sql = await getSql();
  await sql.query(
    `update admin_dual_approvals set status=$2, execution_error=$3 where id=$1 and status='approved'`,
    [approvalId, outcome.ok ? "executed" : "failed", outcome.ok ? null : outcome.error.slice(0, 500)],
  );
}

export async function cancelDualApproval(input: { approvalId: string; actorId: string }) {
  return withTransaction(async (sql) => {
    const rows = await sql.query<{ requested_by: string; status: string }>(
      `select requested_by,status from admin_dual_approvals where id=$1 for update`, [input.approvalId]);
    if (!rows[0]) throw new Error("Approval request not found");
    if (rows[0].requested_by !== input.actorId) throw new Error("Only the person who submitted the request can withdraw it");
    if (rows[0].status !== "pending") throw new Error("This request has already been decided");
    await sql.query(`update admin_dual_approvals set status='cancelled' where id=$1`, [input.approvalId]);
    await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
      "admin.dual_approval.cancelled", "admin_dual_approval", input.approvalId, input.actorId, "admin", null, "success", "{}",
    ]);
    return { cancelled: true };
  });
}

export async function listDualApprovals(capabilities: readonly string[], isOwner: boolean) {
  const sql = await getSql();
  const allowed = isOwner ? ["admin.finance.refunds", "admin.finance.payouts"]
    : ["admin.finance.refunds", "admin.finance.payouts"].filter((c) => capabilities.includes(c));
  if (!allowed.length) return [];
  return sql.query<{
    id: string; action: string; subjectId: string; amount: string; currency: string; payload: Record<string, unknown>;
    requiredCapability: string; requestedBy: string; requesterName: string | null; reason: string; status: string;
    decidedBy: string | null; deciderName: string | null; decisionNote: string | null; executionError: string | null;
    createdAt: string; expiresAt: string; decidedAt: string | null;
  }>(
    `select a.id, a.action, a.subject_id as "subjectId", a.amount::text, a.currency, a.payload,
            a.required_capability as "requiredCapability", a.requested_by as "requestedBy", r.name as "requesterName",
            a.request_reason as reason,
            case when a.status='pending' and a.expires_at<=now() then 'expired' else a.status end as status,
            a.decided_by as "decidedBy", d.name as "deciderName", a.decision_note as "decisionNote",
            a.execution_error as "executionError", a.created_at::text as "createdAt", a.expires_at::text as "expiresAt",
            a.decided_at::text as "decidedAt"
       from admin_dual_approvals a
       left join "user" r on r.id=a.requested_by
       left join "user" d on d.id=a.decided_by
      where a.required_capability = any($1::text[])
      order by case when a.status='pending' and a.expires_at>now() then 0 else 1 end, a.created_at desc
      limit 100`,
    [allowed],
  );
}
