// Client-safe review moderation vocabulary. Must match the CHECK lists in
// migrations/0233_review_moderation.sql (reviews.hidden_reason, review_reports.reason).
export const REVIEW_MODERATION_REASONS = [
  "abusive",
  "spam",
  "off_topic",
  "personal_data",
  "fake_or_incentivised",
  "legal",
  "other",
] as const;

export type ReviewModerationReason = (typeof REVIEW_MODERATION_REASONS)[number];

/** Plain-language labels shown to customers (report) and staff (hide). */
export const REVIEW_MODERATION_REASON_LABELS: Record<ReviewModerationReason, string> = {
  abusive: "Abusive, hateful or threatening",
  spam: "Spam or advertising",
  off_topic: "Not about this product",
  personal_data: "Contains personal information",
  fake_or_incentivised: "Fake, paid for or incentivised",
  legal: "Possibly illegal or a legal complaint",
  other: "Something else",
};

export const REVIEW_REPORT_NOTE_MAX = 500;
export const REVIEW_MODERATION_NOTE_MAX = 1000;
