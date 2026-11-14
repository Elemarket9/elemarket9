import { withTransaction } from "@/lib/db";

/**
 * Prepare (atomically, with audit) and then execute a full-order provider refund
 * as `actorId`. The caller must already have authorized the actor for
 * admin.finance.refunds; the payments boundary re-checks it from the session.
 * The external provider call runs AFTER commit; never inside a DB lock.
 */
export async function executeAdminOrderRefund(input: {
  orderId: string;
  actorId: string;
  note: string;
  source: string;
  approvalId?: string;
}) {
  const requestId = await withTransaction(async (sql) => {
    // The payment points at its order (payments.order_id); orders has no payment column.
    const rows = await sql.query<{ payment_id: string | null }>(
      `select p.id as payment_id
         from orders o join payments p on p.order_id=o.id and p.status='completed'
        where o.id=$1 order by p.created_at desc limit 1 for update of o`, [input.orderId],
    );
    const paymentId = rows[0]?.payment_id;
    if (!paymentId) throw new Error("Order has no completed payment");
    const prepared = await sql.query<{ result: unknown }>(
      `select prepare_provider_refund_for_payment($1,$2,$3) as result`,
      [paymentId, input.actorId, input.source],
    );
    const result = prepared[0]?.result as { requestId?: string } | null;
    if (!result?.requestId) throw new Error("Provider refund request could not be prepared");
    await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
      "admin.refund.execution_requested", "order", input.orderId, input.actorId, "admin", null, "success",
      JSON.stringify({ refundRequestId: result.requestId, reason: input.note.trim(), dualApprovalId: input.approvalId ?? null }),
    ]);
    return String(result.requestId);
  });
  const { executeProviderRefundAsAdmin } = await import("@/modules/payments/public/refunds.server");
  const outcome = await executeProviderRefundAsAdmin(requestId);
  return { ...outcome, status: outcome.status as string };
}
