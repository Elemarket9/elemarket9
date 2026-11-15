import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { RISK_DECISIONS, RISK_NOTE_MAX, RISK_NOTE_MIN, RISK_SEVERITIES, RISK_SUBJECT_TYPES } from "../../risk-review-format";

/**
 * Fraud & risk review queue. Every endpoint requires admin.risk.review.
 * Decisions are records only: suspending a customer or merchant stays with
 * moderateCustomer / moderateMerchant and their own permissions.
 */

const flagId = z.string().regex(/^rf_[a-f0-9]{32}$/);

async function guards() {
  const [auth, verify, rate] = await Promise.all([
    import("@/modules/identity/public/auth/authorization.server"),
    import("@/modules/identity/public/auth/verify.server"),
    import("@/lib/security/rate-limit.server"),
  ]);
  return { ...auth, ...verify, ...rate };
}

/** Call AFTER requireAdminForUserId(userId, "admin.risk.review"). */
async function viewerIsOwner(userId: string) {
  const { getAdminCapabilitiesForUserId } = await guards();
  return (await getAdminCapabilitiesForUserId(userId)).includes("admin.full");
}

async function mutationGuards(userId: string, bucket: string, maxRequests: number) {
  const { requireFreshSession, enforceRateLimit } = await guards();
  await requireFreshSession();
  await enforceRateLimit(bucket, { windowSeconds: 600, maxRequests, subject: userId, identity: "subject" });
}

export const listRiskQueue = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({
    status: z.enum(["open", "resolved", "dismissed", "decided", "all"]).default("open"),
    severity: z.enum(RISK_SEVERITIES).nullish(),
    subjectType: z.enum(RISK_SUBJECT_TYPES).nullish(),
    flagCode: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).nullish(),
    limit: z.number().int().min(1).max(200).default(100),
  }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const { requireAdminForUserId } = await guards();
    await requireAdminForUserId(userId, "admin.risk.review");
    const isOwner = await viewerIsOwner(userId);
    const { listRiskFlags, listRiskFlagCodes } = await import("../../risk-review.server");
    const [flags, flagCodes] = await Promise.all([listRiskFlags(data), listRiskFlagCodes()]);
    return { flags, flagCodes, viewerId: userId, viewerIsOwner: isOwner };
  });

export const getRiskFlag = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ flagId }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const { requireAdminForUserId } = await guards();
    await requireAdminForUserId(userId, "admin.risk.review");
    const { getRiskFlagDetail } = await import("../../risk-review.server");
    const flag = await getRiskFlagDetail(data.flagId);
    if (!flag) throw new Error("Risk flag not found");
    return flag;
  });

export const claimRiskFlagForReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ flagId }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const { requireAdminForUserId } = await guards();
    await requireAdminForUserId(userId, "admin.risk.review");
    await mutationGuards(userId, "admin-risk-claim", 120);
    const { claimRiskFlag } = await import("../../risk-review.server");
    return claimRiskFlag({ flagId: data.flagId, actorId: userId });
  });

export const releaseRiskFlagClaim = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ flagId }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const { requireAdminForUserId } = await guards();
    await requireAdminForUserId(userId, "admin.risk.review");
    await mutationGuards(userId, "admin-risk-claim", 120);
    const isOwner = await viewerIsOwner(userId);
    const { releaseRiskFlag } = await import("../../risk-review.server");
    return releaseRiskFlag({ flagId: data.flagId, actorId: userId, isOwner });
  });

export const decideRiskFlagReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    flagId,
    decision: z.enum(RISK_DECISIONS),
    note: z.string().trim().min(RISK_NOTE_MIN).max(RISK_NOTE_MAX),
  }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const { requireAdminForUserId } = await guards();
    await requireAdminForUserId(userId, "admin.risk.review");
    await mutationGuards(userId, "admin-risk-decision", 60);
    const isOwner = await viewerIsOwner(userId);
    const { decideRiskFlag } = await import("../../risk-review.server");
    return decideRiskFlag({ flagId: data.flagId, actorId: userId, isOwner, decision: data.decision, note: data.note });
  });
