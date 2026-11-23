// Review reporting and moderation (migration 0233). Server-only.
// Authorization (customer / admin.reviews.moderate), fresh-session and rate
// limits are enforced by the transport layer before these run; these functions
// own the data rules, row locking and same-transaction audit records.
import { randomUUID } from "node:crypto";
import { getSql, withTransaction, type Sql } from "@/lib/db";
import type { ReviewModerationReason } from "./review-moderation.shared";

export class ReviewModerationError extends Error {}

type Query = Pick<Sql, "query">;

const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

async function audit(sql: Query, eventType: string, reviewId: string, actorId: string, actorRole: "admin" | "customer", metadata: Record<string, unknown>) {
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [eventType, "review", reviewId, actorId, actorRole, null, "success", JSON.stringify(metadata)]);
}

/** Search ranking uses product_listing_quality; refresh it only where a score already exists. */
async function refreshListingQuality(sql: Query, productId: string) {
  const existing = await sql.query<{ product_id: string }>(`select product_id from product_listing_quality where product_id=$1`, [productId]);
  if (existing[0]) await sql.query(`select calculate_product_listing_quality($1)`, [productId]);
}

// ---- Customer reports ---------------------------------------------------------

export type SubmitReviewReportInput = { reporterId: string; reviewId: string; reason: ReviewModerationReason; note?: string | null };

/** Idempotent per (review, reporter): a repeat report returns the existing one and changes nothing. */
export async function submitReviewReport(input: SubmitReviewReportInput): Promise<{ reportId: string; alreadyReported: boolean }> {
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  return withTransaction(async (sql) => {
    const [review] = await sql.query<{ id: string; user_id: string; moderation_status: string; product_id: string }>(
      `select id,user_id,moderation_status,product_id from reviews where id=$1 for share`, [input.reviewId]);
    if (!review || review.moderation_status !== "published") throw new ReviewModerationError("This review is no longer available.");
    if (review.user_id === input.reporterId) throw new ReviewModerationError("You can't report your own review.");
    const id = newId("rrp");
    const inserted = await sql.query<{ id: string }>(
      `insert into review_reports(id,review_id,reporter_user_id,reason,note) values($1,$2,$3,$4,$5)
       on conflict (review_id,reporter_user_id) do nothing returning id`,
      [id, input.reviewId, input.reporterId, input.reason, note]);
    if (!inserted[0]) {
      const [existing] = await sql.query<{ id: string }>(
        `select id from review_reports where review_id=$1 and reporter_user_id=$2`, [input.reviewId, input.reporterId]);
      return { reportId: existing?.id ?? "", alreadyReported: true };
    }
    await audit(sql, "customer.review.reported", input.reviewId, input.reporterId, "customer",
      { reportId: id, reason: input.reason, productId: review.product_id, hasNote: note !== null });
    return { reportId: id, alreadyReported: false };
  });
}

// ---- Admin queue --------------------------------------------------------------

export type ReviewQueueFilters = {
  status: "all" | "reported" | "published" | "hidden";
  rating?: number | null;
  lowStar?: boolean;
  productId?: string | null;
  merchantId?: string | null;
  limit: number;
  offset: number;
};

export type ReviewQueueItem = {
  id: string; rating: number; body: string; createdAt: string;
  status: "published" | "hidden"; hiddenReason: ReviewModerationReason | null; hiddenNote: string | null;
  moderatedAt: string | null; moderatedByName: string | null;
  reviewerId: string; orderId: string;
  productId: string; productName: string; merchantId: string; merchantName: string;
  merchantResponse: string | null;
  openReports: number; totalReports: number;
  openReasons: Partial<Record<ReviewModerationReason, number>>;
  reportNotes: string[];
};

/** Reported reviews first (most open reports), then newest. Reporter identities never leave the server. */
export async function listReviewModerationQueue(filters: ReviewQueueFilters) {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string; rating: number; body: string; created_at: string; moderation_status: "published" | "hidden";
    hidden_reason: ReviewModerationReason | null; hidden_note: string | null; moderated_at: string | null; moderated_by_name: string | null;
    user_id: string; order_id: string; product_id: string; product_name: string; merchant_id: string; merchant_name: string;
    merchant_response: string | null; open_reports: number; total_reports: number;
    open_reasons: Partial<Record<ReviewModerationReason, number>> | null; report_notes: string[] | null;
  }>(
    `select r.id,r.rating,r.body,
            to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
            r.moderation_status,r.hidden_reason,r.hidden_note,
            to_char(r.moderated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as moderated_at,
            mu.name as moderated_by_name,
            r.user_id,r.order_id,p.id as product_id,p.name as product_name,m.id as merchant_id,m.name as merchant_name,
            rr.body as merchant_response,
            coalesce(rep.open_reports,0)::int as open_reports,coalesce(rep.total_reports,0)::int as total_reports,
            (select jsonb_object_agg(s.reason,s.n) from (select x.reason,count(*)::int n from review_reports x
               where x.review_id=r.id and x.status='open' group by x.reason) s) as open_reasons,
            (select jsonb_agg(s.note order by s.created_at desc) from (select x.note,x.created_at from review_reports x
               where x.review_id=r.id and x.status='open' and x.note is not null order by x.created_at desc limit 5) s) as report_notes
       from reviews r
       join products p on p.id=r.product_id
       join merchants m on m.id=p.merchant_id
       left join review_responses rr on rr.review_id=r.id
       left join "user" mu on mu.id=r.moderated_by
       left join lateral (select count(*) filter (where x.status='open') as open_reports,count(*) as total_reports
                            from review_reports x where x.review_id=r.id) rep on true
      where ($1::text='all' or ($1::text='reported' and coalesce(rep.open_reports,0)>0) or r.moderation_status=$1::text)
        and ($2::int is null or r.rating=$2::int)
        and (not $3::boolean or r.rating<=2)
        and ($4::text is null or p.id=$4::text)
        and ($5::text is null or m.id=$5::text)
      order by coalesce(rep.open_reports,0) desc,r.created_at desc,r.id desc
      limit $6 offset $7`,
    [filters.status, filters.rating ?? null, Boolean(filters.lowStar), filters.productId ?? null, filters.merchantId ?? null, filters.limit + 1, filters.offset]);
  const [summary] = await sql.query<{ reported: number; hidden: number; low_star: number }>(
    `select (select count(distinct review_id)::int from review_reports where status='open') as reported,
            (select count(*)::int from reviews where moderation_status='hidden') as hidden,
            (select count(*)::int from reviews where moderation_status='published' and rating<=2 and created_at>=now()-interval '30 days') as low_star`);
  const items: ReviewQueueItem[] = rows.slice(0, filters.limit).map((r) => ({
    id: r.id, rating: Number(r.rating), body: r.body, createdAt: r.created_at,
    status: r.moderation_status, hiddenReason: r.hidden_reason, hiddenNote: r.hidden_note,
    moderatedAt: r.moderated_at, moderatedByName: r.moderated_by_name,
    reviewerId: r.user_id, orderId: r.order_id,
    productId: r.product_id, productName: r.product_name, merchantId: r.merchant_id, merchantName: r.merchant_name,
    merchantResponse: r.merchant_response,
    openReports: Number(r.open_reports), totalReports: Number(r.total_reports),
    openReasons: r.open_reasons ?? {}, reportNotes: r.report_notes ?? [],
  }));
  return {
    items,
    hasMore: rows.length > filters.limit,
    summary: { openReportedReviews: Number(summary?.reported ?? 0), hiddenReviews: Number(summary?.hidden ?? 0), lowStarLast30Days: Number(summary?.low_star ?? 0) },
  };
}

// ---- Admin actions ------------------------------------------------------------

type LockedReview = { id: string; user_id: string; product_id: string; merchant_id: string; moderation_status: "published" | "hidden"; hidden_reason: string | null };

/** Lock the review and refuse conflicts of interest: staff cannot moderate their own review or a review of a shop they belong to. */
async function lockReviewForModeration(sql: Query, reviewId: string, adminId: string): Promise<LockedReview> {
  const [review] = await sql.query<LockedReview>(
    `select r.id,r.user_id,r.product_id,p.merchant_id,r.moderation_status,r.hidden_reason
       from reviews r join products p on p.id=r.product_id where r.id=$1 for update of r`, [reviewId]);
  if (!review) throw new ReviewModerationError("Review not found.");
  if (review.user_id === adminId) throw new ReviewModerationError("You can't moderate a review you wrote. Ask another administrator.");
  const linked = await sql.query<{ merchant_id: string }>(
    `select merchant_id from merchant_accounts where merchant_id=$1 and user_id=$2 and status='active'`, [review.merchant_id, adminId]);
  if (linked[0]) throw new ReviewModerationError("You are linked to this shop, so you can't moderate its reviews. Ask another administrator.");
  return review;
}

export async function hideReview(input: { reviewId: string; adminId: string; reason: ReviewModerationReason; note: string }) {
  const note = input.note.trim().slice(0, 1000);
  return withTransaction(async (sql) => {
    const review = await lockReviewForModeration(sql, input.reviewId, input.adminId);
    if (review.moderation_status === "hidden") throw new ReviewModerationError("This review is already hidden.");
    await sql.query(
      `update reviews set moderation_status='hidden',hidden_reason=$2,hidden_note=$3,moderated_by=$4,moderated_at=now() where id=$1`,
      [input.reviewId, input.reason, note, input.adminId]);
    const actioned = await sql.query<{ id: string }>(
      `update review_reports set status='actioned',resolved_by=$2,resolved_at=now() where review_id=$1 and status='open' returning id`,
      [input.reviewId, input.adminId]);
    await refreshListingQuality(sql, review.product_id);
    await audit(sql, "admin.review.hidden", input.reviewId, input.adminId, "admin",
      { reason: input.reason, note, productId: review.product_id, merchantId: review.merchant_id, reportsActioned: actioned.length });
    return { reviewId: input.reviewId, status: "hidden" as const, reportsActioned: actioned.length };
  });
}

export async function restoreReview(input: { reviewId: string; adminId: string; note: string }) {
  const note = input.note.trim().slice(0, 1000);
  return withTransaction(async (sql) => {
    const review = await lockReviewForModeration(sql, input.reviewId, input.adminId);
    if (review.moderation_status === "published") throw new ReviewModerationError("This review is already visible.");
    await sql.query(
      `update reviews set moderation_status='published',hidden_reason=null,hidden_note=null,moderated_by=$2,moderated_at=now() where id=$1`,
      [input.reviewId, input.adminId]);
    await refreshListingQuality(sql, review.product_id);
    await audit(sql, "admin.review.restored", input.reviewId, input.adminId, "admin",
      { note, previousReason: review.hidden_reason, productId: review.product_id, merchantId: review.merchant_id });
    return { reviewId: input.reviewId, status: "published" as const };
  });
}

export async function dismissReviewReports(input: { reviewId: string; adminId: string; note?: string | null }) {
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
  return withTransaction(async (sql) => {
    const review = await lockReviewForModeration(sql, input.reviewId, input.adminId);
    const dismissed = await sql.query<{ id: string }>(
      `update review_reports set status='dismissed',resolved_by=$2,resolved_at=now() where review_id=$1 and status='open' returning id`,
      [input.reviewId, input.adminId]);
    if (!dismissed.length) throw new ReviewModerationError("There are no open reports on this review.");
    await audit(sql, "admin.review.reports_dismissed", input.reviewId, input.adminId, "admin",
      { dismissed: dismissed.length, note, productId: review.product_id, merchantId: review.merchant_id });
    return { reviewId: input.reviewId, dismissed: dismissed.length };
  });
}
