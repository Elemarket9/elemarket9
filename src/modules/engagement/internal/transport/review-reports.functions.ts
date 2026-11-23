import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { REVIEW_MODERATION_REASONS, REVIEW_REPORT_NOTE_MAX } from "../review-moderation.shared";

const reportSchema = z.object({
  reviewId: z.string().trim().min(1).max(128),
  reason: z.enum(REVIEW_MODERATION_REASONS),
  note: z.string().trim().max(REVIEW_REPORT_NOTE_MAX).optional(),
});

/** A signed-in customer flags a review for staff. Reporting never hides anything by itself. */
export const reportReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(reportSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const [{ requireCustomerForUserId }, { enforceRateLimit }, { submitReviewReport }] = await Promise.all([
      import("@/modules/identity/public/auth/authorization.server"),
      import("@/lib/security/rate-limit.server"),
      import("../review-moderation.server"),
    ]);
    await requireCustomerForUserId(userId);
    await enforceRateLimit("review-report", { windowSeconds: 3600, maxRequests: 10, subject: userId, identity: "subject" });
    const result = await submitReviewReport({ reporterId: userId, reviewId: data.reviewId, reason: data.reason, note: data.note });
    return { reported: true as const, alreadyReported: result.alreadyReported };
  });
