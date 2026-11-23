// Product review moderation on REAL PostgreSQL (migration 0233).
// A hidden review must vanish from every public read path and every rating
// aggregate, come back on restore, and every moderation step must be audited.
// Reports are idempotent per customer and a customer can never report their
// own review (enforced by the database, not only by application code).
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test node --test tests/admin-reviews.postgres.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { configureSimulationEnv, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
const tag = randomBytes(4).toString("hex");
const admin = `rvw_admin_${tag}`;
const linkedAdmin = `rvw_linked_admin_${tag}`;
const reporter = `rvw_reporter_${tag}`;
let db, harness, sql, moderation, catalog, homepage, engagement, seed;
let goodReview, badReview;

async function addUser(id, role = "customer") {
  await sql.query(`insert into "user"(id,name,email,"emailVerified",role) values($1,$1,$2,true,$3)`, [id, `${id}@example.test`, role]);
}
async function addReview(userId, rating, body) {
  const id = `rev_${randomBytes(12).toString("hex")}`;
  await sql.query(`insert into reviews(id,user_id,product_id,order_id,rating,body) values($1,$2,$3,$4,$5,$6)`,
    [id, userId, seed.product, seed.order, rating, body]);
  return id;
}

/** Everything a shopper or merchant can see about this product's reviews and ratings. */
async function publicState() {
  const [detail] = await catalog.loadPublicProductRows(sql, seed.product);
  const [hit] = await catalog.hydrateSearchHits(sql, [{ id: seed.product }], {});
  const [home] = await sql.query(`${homepage.productSelect} where p.id=$1`, [seed.product]);
  const list = await engagement.queryPublicProductReviews(sql, { productId: seed.product, limit: 50 });
  const [{ snapshot }] = await sql.query(`select merchant_performance_snapshot($1) as snapshot`, [seed.merchant]);
  const [quality] = await sql.query(`select customer_signal_score from product_listing_quality where product_id=$1`, [seed.product]);
  const [view] = await sql.query(`select count(*)::int n from public_reviews where product_id=$1`, [seed.product]);
  return {
    detail: { avg: Number(detail.avg_rating), count: detail.review_count },
    search: { avg: hit.avgRating, count: hit.reviewCount },
    homepage: { avg: Number(home.avg_rating), count: home.review_count },
    listIds: list.reviews.map((r) => r.id).sort(),
    performance: { avg: Number(snapshot.avgRating), count: snapshot.reviewCount },
    listingQualityCustomerSignal: quality?.customer_signal_score,
    viewCount: view.n,
  };
}

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url });
  harness = await startHarness();
  sql = harness.sql;
  moderation = await harness.load("/src/modules/engagement/internal/review-moderation.server.ts");
  catalog = await harness.load("/src/modules/catalog/internal/catalog.ts");
  homepage = await harness.load("/src/modules/catalog/internal/homepage.functions.ts");
  engagement = await harness.load("/src/modules/engagement/internal/customer-engagement.functions.ts");
  seed = await seedOrder(sql);
  await sql.query(`update products set stock=10 where id=$1`, [seed.product]);
  await sql.query(`update product_variants set stock=10 where id=$1`, [seed.variant]);
  await addUser(admin, "admin");
  await addUser(linkedAdmin, "admin");
  await addUser(reporter);
  // Staff member who also runs this shop (merchant_accounts is keyed by merchant).
  await sql.query(`insert into merchant_accounts(merchant_id,user_id,status) values($1,$2,'active')
                   on conflict (merchant_id) do update set user_id=excluded.user_id,status='active'`, [seed.merchant, linkedAdmin]);
  goodReview = await addReview(seed.user, 5, "Works perfectly, fast delivery");
  badReview = await addReview(`rvw_author_${tag}`, 1, "Call me on 024 000 0000 for a better deal");
  // A ranking score already exists, so moderation must refresh it.
  await sql.query(`select calculate_product_listing_quality($1)`, [seed.product]);
});
after(async () => {
  if (!enabled) return;
  await harness?.close();
  await db?.drop();
});

test("before moderation every read path counts both reviews", { skip }, async () => {
  const s = await publicState();
  assert.deepEqual(s.detail, { avg: 3, count: 2 });
  assert.deepEqual(s.search, { avg: 3, count: 2 });
  assert.deepEqual(s.homepage, { avg: 3, count: 2 });
  assert.deepEqual(s.performance, { avg: 3, count: 2 });
  assert.deepEqual(s.listIds, [goodReview, badReview].sort());
  assert.equal(s.listingQualityCustomerSignal, 50);
  assert.equal(s.viewCount, 2);
});

test("a customer cannot report their own review, even bypassing the application", { skip }, async () => {
  await assert.rejects(moderation.submitReviewReport({ reporterId: seed.user, reviewId: goodReview, reason: "spam" }), /own review/);
  await assert.rejects(
    sql.query(`insert into review_reports(id,review_id,reporter_user_id,reason) values('rrp_self',$1,$2,'spam')`, [goodReview, seed.user]),
    /review_reports_no_self_report/,
  );
});

test("reporting is idempotent per customer and validated by the database", { skip }, async () => {
  const first = await moderation.submitReviewReport({ reporterId: reporter, reviewId: badReview, reason: "personal_data", note: "Has a phone number" });
  const again = await moderation.submitReviewReport({ reporterId: reporter, reviewId: badReview, reason: "spam" });
  assert.equal(first.alreadyReported, false);
  assert.equal(again.alreadyReported, true);
  assert.equal(again.reportId, first.reportId);
  const rows = await sql.query(`select reason,status from review_reports where review_id=$1`, [badReview]);
  assert.deepEqual(rows, [{ reason: "personal_data", status: "open" }], "second report changed nothing");
  await assert.rejects(sql.query(`insert into review_reports(id,review_id,reporter_user_id,reason,note) values('rrp_long',$1,'someone_else','spam',$2)`, [badReview, "x".repeat(501)]), /check/i);
  await assert.rejects(sql.query(`insert into review_reports(id,review_id,reporter_user_id,reason) values('rrp_bad',$1,'someone_else','boring')`, [badReview]), /check/i);
  const audits = await sql.query(`select event_type,actor_user_id from audit_events where resource_id=$1 and event_type='customer.review.reported'`, [badReview]);
  assert.equal(audits.length, 1, "only the first report is audited");
});

test("the moderation queue puts reported reviews first and hides reporter identities", { skip }, async () => {
  const q = await moderation.listReviewModerationQueue({ status: "all", limit: 10, offset: 0 });
  assert.equal(q.items[0].id, badReview);
  assert.equal(q.items[0].openReports, 1);
  assert.deepEqual(q.items[0].openReasons, { personal_data: 1 });
  assert.ok(!JSON.stringify(q).includes(reporter), "reporter id never leaves the server");
  const low = await moderation.listReviewModerationQueue({ status: "all", lowStar: true, merchantId: seed.merchant, limit: 10, offset: 0 });
  assert.deepEqual(low.items.map((i) => i.id), [badReview]);
  const five = await moderation.listReviewModerationQueue({ status: "all", rating: 5, productId: seed.product, limit: 10, offset: 0 });
  assert.deepEqual(five.items.map((i) => i.id), [goodReview]);
  assert.ok(q.summary.openReportedReviews >= 1);
});

test("the database refuses an inconsistent hidden state", { skip }, async () => {
  await assert.rejects(sql.query(`update reviews set moderation_status='hidden' where id=$1`, [badReview]), /reviews_moderation_consistency_check/);
  await assert.rejects(sql.query(`update reviews set moderation_status='hidden',hidden_reason='boring',moderated_by='x',moderated_at=now() where id=$1`, [badReview]), /reviews_hidden_reason_check/);
});

test("staff linked to the shop cannot moderate its reviews", { skip }, async () => {
  await assert.rejects(moderation.hideReview({ reviewId: badReview, adminId: linkedAdmin, reason: "spam", note: "Hiding a bad review" }), /linked to this shop/);
  const [r] = await sql.query(`select moderation_status from reviews where id=$1`, [badReview]);
  assert.equal(r.moderation_status, "published");
});

test("a hidden review disappears from every public read path and every rating aggregate", { skip }, async () => {
  const result = await moderation.hideReview({ reviewId: badReview, adminId: admin, reason: "personal_data", note: "Contains a phone number" });
  assert.equal(result.reportsActioned, 1);
  const s = await publicState();
  assert.deepEqual(s.detail, { avg: 5, count: 1 });
  assert.deepEqual(s.search, { avg: 5, count: 1 });
  assert.deepEqual(s.homepage, { avg: 5, count: 1 });
  assert.deepEqual(s.performance, { avg: 5, count: 1 });
  assert.deepEqual(s.listIds, [goodReview]);
  assert.equal(s.listingQualityCustomerSignal, 100, "search ranking signal refreshed");
  assert.equal(s.viewCount, 1);
  const [stored] = await sql.query(`select moderation_status,hidden_reason,moderated_by from reviews where id=$1`, [badReview]);
  assert.deepEqual(stored, { moderation_status: "hidden", hidden_reason: "personal_data", moderated_by: admin });
  const [report] = await sql.query(`select status,resolved_by from review_reports where review_id=$1`, [badReview]);
  assert.deepEqual(report, { status: "actioned", resolved_by: admin });
  await assert.rejects(moderation.hideReview({ reviewId: badReview, adminId: admin, reason: "spam", note: "Second click" }), /already hidden/);
  await assert.rejects(moderation.submitReviewReport({ reporterId: `rvw_other_${tag}`, reviewId: badReview, reason: "spam" }), /no longer available/);
  // The same customer still cannot post a second review for the same purchase.
  const [{ n }] = await sql.query(`select count(*)::int n from reviews where order_id=$1 and product_id=$2`, [seed.order, seed.product]);
  assert.equal(n, 2);
});

test("merchant health scoring ignores hidden reviews", { skip }, async () => {
  const [{ def }] = await sql.query(`select pg_get_functiondef('recalculate_merchant_health_score(text)'::regprocedure) as def`);
  assert.match(def, /from reviews r[\s\S]*?r\.moderation_status = 'published'[\s\S]*?r\.created_at >= v_start/);
});

test("restore brings the review back everywhere", { skip }, async () => {
  await assert.rejects(moderation.restoreReview({ reviewId: goodReview, adminId: admin, note: "Not hidden" }), /already visible/);
  await moderation.restoreReview({ reviewId: badReview, adminId: admin, note: "Number belongs to the shop, not personal" });
  const s = await publicState();
  assert.deepEqual(s.detail, { avg: 3, count: 2 });
  assert.deepEqual(s.search, { avg: 3, count: 2 });
  assert.deepEqual(s.homepage, { avg: 3, count: 2 });
  assert.deepEqual(s.performance, { avg: 3, count: 2 });
  assert.deepEqual(s.listIds, [goodReview, badReview].sort());
  assert.equal(s.listingQualityCustomerSignal, 50);
  const [stored] = await sql.query(`select moderation_status,hidden_reason,hidden_note from reviews where id=$1`, [badReview]);
  assert.deepEqual(stored, { moderation_status: "published", hidden_reason: null, hidden_note: null });
});

test("dismissing reports keeps the review visible and needs open reports", { skip }, async () => {
  await moderation.submitReviewReport({ reporterId: `rvw_second_${tag}`, reviewId: goodReview, reason: "fake_or_incentivised" });
  const r = await moderation.dismissReviewReports({ reviewId: goodReview, adminId: admin, note: "Genuine verified purchase" });
  assert.equal(r.dismissed, 1);
  await assert.rejects(moderation.dismissReviewReports({ reviewId: goodReview, adminId: admin }), /no open reports/);
  const [rev] = await sql.query(`select moderation_status from reviews where id=$1`, [goodReview]);
  assert.equal(rev.moderation_status, "published");
});

test("every moderation decision is in the audit history, attributed to the administrator", { skip }, async () => {
  const rows = await sql.query(
    `select event_type,resource_id,actor_user_id,actor_role,metadata from audit_events
      where resource_type='review' and event_type like 'admin.review.%' order by id`);
  assert.deepEqual(rows.map((r) => [r.event_type, r.resource_id, r.actor_user_id, r.actor_role]), [
    ["admin.review.hidden", badReview, admin, "admin"],
    ["admin.review.restored", badReview, admin, "admin"],
    ["admin.review.reports_dismissed", goodReview, admin, "admin"],
  ]);
  assert.equal(rows[0].metadata.reason, "personal_data");
  assert.equal(rows[0].metadata.reportsActioned, 1);
  assert.equal(rows[1].metadata.previousReason, "personal_data");
  assert.equal(rows[2].metadata.dismissed, 1);
});
