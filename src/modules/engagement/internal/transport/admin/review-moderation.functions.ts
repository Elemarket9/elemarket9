// Admin review moderation (admin.reviews.moderate). Merchants have no path here:
// they can only reply to reviews. Every mutation needs a fresh session, is rate
// limited per administrator, and is audited in the same transaction.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { REVIEW_MODERATION_NOTE_MAX, REVIEW_MODERATION_REASONS, REVIEW_REPORT_NOTE_MAX } from "../../review-moderation.shared";

const CAPABILITY = "admin.reviews.moderate" as const;
const reviewId = z.string().trim().min(1).max(128);
const ref = z.string().trim().min(1).max(128).optional();

async function deps() {
  const [auth, verify, rate, core] = await Promise.all([
    import("@/modules/identity/public/auth/authorization.server"),
    import("@/modules/identity/public/auth/verify.server"),
    import("@/lib/security/rate-limit.server"),
    import("../../review-moderation.server"),
  ]);
  return { ...auth, ...verify, ...rate, ...core };
}

/** After the permission check: fresh session (same person) and a per-admin rate limit before any change. */
async function guardMutation(d: Awaited<ReturnType<typeof deps>>, adminId: string) {
  const sessionUser = await d.requireFreshSession();
  if (sessionUser !== adminId) throw new Error("Fresh authentication required");
  await d.enforceRateLimit("admin-review-moderation", { windowSeconds: 600, maxRequests: 120, subject: adminId, identity: "subject" });
}

const queueSchema = z.object({
  status: z.enum(["all", "reported", "published", "hidden"]).default("all"),
  rating: z.number().int().min(1).max(5).optional(),
  lowStar: z.boolean().optional(),
  productId: ref,
  merchantId: ref,
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(5000).default(0),
});

export const loadReviewModerationQueue = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(queueSchema)
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    const d = await deps();
    await d.requireAdminForUserId(adminId, CAPABILITY);
    return d.listReviewModerationQueue(data);
  });

export const hideReviewAdmin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ reviewId, reason: z.enum(REVIEW_MODERATION_REASONS), note: z.string().trim().min(5).max(REVIEW_MODERATION_NOTE_MAX) }))
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    const d = await deps();
    await d.requireAdminForUserId(adminId, CAPABILITY);
    await guardMutation(d, adminId);
    return d.hideReview({ reviewId: data.reviewId, adminId, reason: data.reason, note: data.note });
  });

export const restoreReviewAdmin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ reviewId, note: z.string().trim().min(5).max(REVIEW_MODERATION_NOTE_MAX) }))
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    const d = await deps();
    await d.requireAdminForUserId(adminId, CAPABILITY);
    await guardMutation(d, adminId);
    return d.restoreReview({ reviewId: data.reviewId, adminId, note: data.note });
  });

export const dismissReviewReportsAdmin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ reviewId, note: z.string().trim().max(REVIEW_REPORT_NOTE_MAX).optional() }))
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    const d = await deps();
    await d.requireAdminForUserId(adminId, CAPABILITY);
    await guardMutation(d, adminId);
    return d.dismissReviewReports({ reviewId: data.reviewId, adminId, note: data.note });
  });
