import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";

const approvalId = z.string().regex(/^dap_[a-f0-9]{32}$/);
const note = z.string().trim().min(12).max(2000);

async function guards() {
  const [auth, verify, rate] = await Promise.all([
    import("@/modules/identity/public/auth/authorization.server"),
    import("@/modules/identity/public/auth/verify.server"),
    import("@/lib/security/rate-limit.server"),
  ]);
  return { ...auth, ...verify, ...rate };
}

/** Approval queue for staff who can approve refunds and/or payout settlements. */
export const loadFinanceApprovals = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = getAuthenticatedUserId(context);
    const { getAdminCapabilitiesForUserId } = await guards();
    const capabilities = await getAdminCapabilitiesForUserId(userId);
    const isOwner = capabilities.includes("admin.full");
    if (!isOwner && !capabilities.includes("admin.finance.refunds") && !capabilities.includes("admin.finance.payouts")) {
      throw new Error("Forbidden: administrator permission required");
    }
    const { listDualApprovals, dualApprovalThreshold } = await import("../../dual-approval.server");
    const approvals = await listDualApprovals(capabilities, isOwner);
    // Only display-safe fields leave the server; the stored payload stays private.
    const rows = approvals.map(({ payload, ...a }) => ({
      ...a,
      payoutOutcome: typeof payload?.outcome === "string" ? payload.outcome : null,
      providerReference: typeof payload?.providerReference === "string" ? payload.providerReference : null,
    }));
    return { approvals: rows, viewerId: userId, threshold: dualApprovalThreshold() };
  });

/** Second person approves or rejects. On approval the action runs under the approver's identity. */
export const decideFinanceApproval = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ approvalId, decision: z.enum(["approve", "reject"]), note }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const [request] = await sql.query<{ required_capability: "admin.finance.refunds" | "admin.finance.payouts" }>(
      `select required_capability from admin_dual_approvals where id=$1`, [data.approvalId]);
    if (!request) throw new Error("Approval request not found");
    const { requireAdminForUserId, requireFreshSession, enforceRateLimit } = await guards();
    await requireAdminForUserId(userId, request.required_capability);
    await requireFreshSession();
    await enforceRateLimit("admin-dual-approval-decision", { windowSeconds: 600, maxRequests: 30, subject: userId, identity: "subject" });

    const { decideDualApproval, recordDualApprovalOutcome } = await import("../../dual-approval.server");
    const row = await decideDualApproval({ approvalId: data.approvalId, deciderId: userId, decision: data.decision, note: data.note });
    if (data.decision === "reject") return { status: "rejected" as const };
    try {
      if (row.action === "order_refund") {
        const { executeAdminOrderRefund } = await import("../../admin-refunds.server");
        const result = await executeAdminOrderRefund({
          orderId: row.subject_id, actorId: userId, note: row.request_reason,
          source: "admin_refund_dual_approved", approvalId: row.id,
        });
        await recordDualApprovalOutcome(row.id, { ok: true });
        return { status: "executed" as const, detail: result.status };
      }
      const payload = row.payload as { outcome: "paid" | "failed"; evidence: string; providerReference?: string | null };
      const { resolvePayoutByAdmin } = await import("@/modules/wallet/public/wallet.server");
      const result = await resolvePayoutByAdmin({
        payoutId: row.subject_id, outcome: payload.outcome, adminId: userId, providerReference: payload.providerReference ?? undefined,
        evidence: `${payload.evidence} [two-person approval ${row.id}; requested by ${row.requested_by}]`,
      });
      await recordDualApprovalOutcome(row.id, { ok: true });
      return { status: "executed" as const, detail: result.status };
    } catch (error) {
      await recordDualApprovalOutcome(row.id, { ok: false, error: error instanceof Error ? error.message : "execution failed" });
      throw error;
    }
  });

/** The requester may withdraw their own pending request. */
export const cancelFinanceApproval = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ approvalId }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const { getAdminCapabilitiesForUserId, requireFreshSession } = await guards();
    const capabilities = await getAdminCapabilitiesForUserId(userId);
    if (!capabilities.some((c) => ["admin.full", "admin.finance.refunds", "admin.finance.payouts"].includes(c))) {
      throw new Error("Forbidden: administrator permission required");
    }
    await requireFreshSession();
    const { cancelDualApproval } = await import("../../dual-approval.server");
    return cancelDualApproval({ approvalId: data.approvalId, actorId: userId });
  });

/**
 * Settle a stuck payout from provider evidence. "Requeue" retries sending and
 * moves no money by itself. "Paid" or "failed" above the threshold need a
 * second administrator: "failed" returns funds to the merchant's available
 * balance, so a wrong decision could pay the merchant twice.
 */
export const requestPayoutResolution = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    payoutId: z.string().regex(/^wpo_[a-f0-9]{32}$/),
    outcome: z.enum(["paid", "failed", "requeue"]),
    evidence: z.string().trim().min(20).max(2000),
    providerReference: z.string().trim().min(1).max(256).optional(),
  }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const { requireAdminForUserId, requireFreshSession, enforceRateLimit } = await guards();
    await requireAdminForUserId(userId, "admin.finance.payouts");
    await requireFreshSession();
    await enforceRateLimit("admin-payout-resolution", { windowSeconds: 600, maxRequests: 20, subject: userId, identity: "subject" });
    const { withTransaction } = await import("@/lib/db");
    const { requiresDualApproval, createDualApproval } = await import("../../dual-approval.server");
    const queued = await withTransaction(async (sql) => {
      const [payout] = await sql.query<{ amount: string }>(
        `select amount::text from wallet_payouts where id=$1 for update`, [data.payoutId]);
      if (!payout) throw new Error("Payout not found");
      if (data.outcome === "requeue" || !requiresDualApproval(payout.amount)) return null;
      return createDualApproval(sql, {
        action: "wallet_payout_resolution", subjectId: data.payoutId, amount: payout.amount, currency: "GHS",
        payload: { outcome: data.outcome, evidence: data.evidence, providerReference: data.providerReference ?? null },
        capability: "admin.finance.payouts", requestedBy: userId, reason: data.evidence,
      });
    });
    if (queued) return { status: "awaiting_approval" as const, approvalId: queued.approvalId };
    const { resolvePayoutByAdmin } = await import("@/modules/wallet/public/wallet.server");
    const result = await resolvePayoutByAdmin({ ...data, adminId: userId });
    return { status: "resolved" as const, detail: result.status };
  });
