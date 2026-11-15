// Fraud & risk review queue on REAL PostgreSQL (migration 0225).
// Flags come from the real producers (checkout risk via create_pending_order,
// and the scoring functions), claims are exclusive under concurrency, only the
// claimer (or the Main Administrator) decides, decisions are final and audited.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test node --test tests/admin-risk.postgres.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { checkout, configureSimulationEnv, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
let db, harness, sql, risk;
const tag = randomBytes(4).toString("hex");
const alice = `rk_alice_${tag}`; // reviewer
const bob = `rk_bob_${tag}`; // reviewer
const olivia = `rk_owner_${tag}`; // Main Administrator
const NOTE = "Checked order history and payment trail with the provider";

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url });
  harness = await startHarness();
  sql = harness.sql;
  risk = await harness.load("/src/modules/administration/internal/risk-review.server.ts");
  for (const id of [alice, bob, olivia]) {
    await sql.query(`insert into "user"(id,name,email,"emailVerified",role) values($1,$1,$2,true,'admin')`, [id, `${id}@example.test`]);
  }
  await sql.query(`insert into admin_staff_roles(user_id,staff_role,status) values($1,'owner','active')`, [olivia]);
});
after(async () => {
  if (!enabled) return;
  await harness?.close();
  await db?.drop();
});

let n = 0;
/** A fresh customer flagged by the real checkout scoring function (new account + GH₵ 20,000). */
async function customerFlag() {
  const user = `rk_cust_${tag}_${++n}`;
  await sql.query(`insert into "user"(id,name,email,"emailVerified") values($1,'Kofi Boateng',$2,true)`, [user, `kofi.${n}@example.test`]);
  const [{ result }] = await sql.query(
    `select evaluate_checkout_risk($1,$2,20000,20000,$3) as result`, [user, "a".repeat(64), `order_ref_${n}`]);
  assert.equal(result.decision, "review");
  const [flag] = await sql.query(`select id from risk_flags where subject_type='customer' and subject_id=$1 and status='open'`, [user]);
  assert.ok(flag, "the producer created an open flag");
  return { user, flagId: flag.id };
}

async function expireClaim(flagId) {
  await sql.query(`alter table risk_flags disable trigger risk_flags_guard`);
  await sql.query(`update risk_flags set assigned_at=now()-interval '31 minutes' where id=$1`, [flagId]);
  await sql.query(`alter table risk_flags enable trigger risk_flags_guard`);
}

test("a real checkout flagged by the risk engine appears in the review queue", { skip }, async () => {
  const seed = await seedOrder(sql);
  await sql.query(`update product_variants set stock=20 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=20 where id=$1`, [seed.product]);
  // Three failed payment attempts in the last 30 minutes (+20) ...
  for (let i = 1; i <= 3; i++) {
    await sql.query(
      `insert into payment_attempts(id,payment_id,attempt_no,provider_key,amount,currency,status)
       select $1,$2,$3,'paystack',p.amount,'GHS','failed' from payments p where p.id=$2`, [`rk_pa_${tag}_${i}`, seed.payment, i]);
  }
  // ... and checkout velocity (+35 once 5 orders exist in 10 minutes) = 55 -> review.
  // Unpaid orders are capped at 3 per customer, so abandon each one (they
  // still count towards velocity, exactly like a card-testing pattern).
  const orders = [];
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
  for (let i = 0; i < 5; i++) {
    orders.push(await checkout(sql, seed));
    if (i < 4) await sql.query(`update orders set status='cancelled' where id=$1`, [orders[i].orderId]);
  }
  const flags = await sql.query(`select id, evidence, occurrence_count from risk_flags where subject_type='customer' and subject_id=$1`, [seed.user]);
  assert.equal(flags.length, 1, "one open flag for the customer");
  assert.equal(flags[0].evidence.referenceId, orders.at(-1).orderId);
  assert.deepEqual(flags[0].evidence.reasons, ["checkout_velocity", "payment_failures"]);
  // A further flagged checkout refreshes the same open flag instead of flooding the queue.
  const sixth = await checkout(sql, seed);
  const [again] = await sql.query(`select occurrence_count, latest_evidence from risk_flags where id=$1`, [flags[0].id]);
  assert.equal(again.occurrence_count, 2);

  const queue = await risk.listRiskFlags({ status: "open", subjectType: "customer", flagCode: "checkout_review" });
  const item = queue.find((f) => f.id === flags[0].id);
  assert.ok(item, "flag is listed");
  assert.equal(item.severity, "high");
  assert.equal(item.subject.name, "Integration Customer");
  assert.match(item.subject.maskedEmail, /^i\*+[a-z0-9]@i\*+n\.test$/);
  assert.ok(!item.subject.maskedEmail.includes(seed.user), "email is masked");
  assert.equal(item.related.openOrders, 2, "the two unpaid orders still open");

  const detail = await risk.getRiskFlagDetail(flags[0].id);
  assert.deepEqual(new Set(detail.openOrders.map((o) => o.id)), new Set([orders[4].orderId, sixth.orderId]), "cancelled orders are not open");
  assert.equal(again.latest_evidence.referenceId, sixth.orderId);
  const reasons = detail.evidence.find((e) => e.key === "reasons");
  assert.match(reasons.value, /Many checkouts in 10 minutes/);
  assert.ok(detail.evidence.every((e) => typeof e.value === "string"));
});

test("merchant fund-release risk produces a critical flag and the queue is ordered by severity then age", { skip }, async () => {
  const seed = await seedOrder(sql);
  const [{ result }] = await sql.query(`select evaluate_merchant_withdrawal_risk($1,500) as result`, [seed.merchant]);
  assert.equal(result.decision, "block");
  const { flagId: older } = await customerFlag();
  const { flagId: newer } = await customerFlag();
  const queue = await risk.listRiskFlags({ status: "open" });
  const merchantFlag = queue.find((f) => f.subjectType === "merchant" && f.subjectId === seed.merchant);
  assert.equal(merchantFlag.flagCode, "fund_release_blocked");
  assert.equal(merchantFlag.severity, "critical");
  assert.equal(merchantFlag.subject.name, "Integration Merchant");
  assert.equal(merchantFlag.subject.status, "active");
  assert.equal(merchantFlag.subject.maskedEmail, null);
  assert.equal(queue[0].severity, "critical", "critical first");
  const ids = queue.map((f) => f.id);
  assert.ok(ids.indexOf(older) < ids.indexOf(newer), "same severity: oldest first");
  const ranks = queue.map((f) => ["critical", "high", "medium", "low"].indexOf(f.severity));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  const filtered = await risk.listRiskFlags({ status: "open", severity: "critical", subjectType: "merchant" });
  assert.ok(filtered.length >= 1 && filtered.every((f) => f.severity === "critical" && f.subjectType === "merchant"));
});

test("two reviewers claiming at the same moment: exactly one wins", { skip }, async () => {
  for (let round = 0; round < 3; round++) {
    const { flagId } = await customerFlag();
    const results = await Promise.allSettled([
      risk.claimRiskFlag({ flagId, actorId: alice }),
      risk.claimRiskFlag({ flagId, actorId: bob }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    assert.equal(won.length, 1, "exactly one claim succeeds");
    assert.match(lost[0].reason.message, /Another reviewer/);
    const [row] = await sql.query(`select assigned_to from risk_flags where id=$1`, [flagId]);
    assert.equal(row.assigned_to, won[0].value.assignedTo);
  }
});

test("only the reviewer holding the claim may decide, and a live claim cannot be stolen", { skip }, async () => {
  const { flagId } = await customerFlag();
  await assert.rejects(risk.decideRiskFlag({ flagId, actorId: alice, isOwner: false, decision: "confirmed_monitor", note: NOTE }), /Claim this flag/);
  await risk.claimRiskFlag({ flagId, actorId: alice });
  await assert.rejects(risk.claimRiskFlag({ flagId, actorId: bob }), /Another reviewer/);
  await assert.rejects(risk.decideRiskFlag({ flagId, actorId: bob, isOwner: false, decision: "dismissed_false_positive", note: NOTE }), /Claim this flag/);
  await assert.rejects(risk.releaseRiskFlag({ flagId, actorId: bob, isOwner: false }), /Only the reviewer/);
  // The database holds the same line when application code is bypassed.
  await assert.rejects(
    sql.query(`update risk_flags set status='dismissed', decision='dismissed_false_positive', resolution_note=$2, resolved_by=$3, resolved_at=now() where id=$1`, [flagId, NOTE, bob]),
    /live claim/);
  await assert.rejects(sql.query(`update risk_flags set assigned_to=$2, assigned_at=now() where id=$1`, [flagId, bob]), /claimed by another reviewer/);
  await assert.rejects(risk.decideRiskFlag({ flagId, actorId: alice, isOwner: false, decision: "confirmed_monitor", note: "too short" }), /note/);
  const result = await risk.decideRiskFlag({ flagId, actorId: alice, isOwner: false, decision: "confirmed_monitor", note: NOTE });
  assert.deepEqual([result.status, result.decision], ["resolved", "confirmed_monitor"]);
  const [row] = await sql.query(`select status, decision, resolved_by, resolution_note, resolved_at is not null as stamped from risk_flags where id=$1`, [flagId]);
  assert.deepEqual(row, { status: "resolved", decision: "confirmed_monitor", resolved_by: alice, resolution_note: NOTE, stamped: true });
});

test("an expired claim can be taken over; the old claimer can no longer decide", { skip }, async () => {
  const { flagId } = await customerFlag();
  await risk.claimRiskFlag({ flagId, actorId: alice });
  await expireClaim(flagId);
  await assert.rejects(risk.decideRiskFlag({ flagId, actorId: alice, isOwner: false, decision: "dismissed_false_positive", note: NOTE }), /expired/);
  const [listed] = (await risk.listRiskFlags({ status: "open" })).filter((f) => f.id === flagId);
  assert.equal(listed.claimActive, false);
  const taken = await risk.claimRiskFlag({ flagId, actorId: bob });
  assert.equal(taken.assignedTo, bob);
  await risk.decideRiskFlag({ flagId, actorId: bob, isOwner: false, decision: "dismissed_false_positive", note: NOTE });
  const [claimed] = await sql.query(
    `select metadata from audit_events where resource_id=$1 and event_type='admin.risk_flag.claimed' and actor_user_id=$2`, [flagId, bob]);
  assert.equal(claimed.metadata.expiredClaimTakenFrom, alice);
});

test("the Main Administrator may decide without a claim, recorded as an override", { skip }, async () => {
  const { flagId } = await customerFlag();
  await risk.claimRiskFlag({ flagId, actorId: alice });
  await risk.decideRiskFlag({ flagId, actorId: olivia, isOwner: true, decision: "dismissed_false_positive", note: NOTE });
  const [event] = await sql.query(`select metadata from audit_events where resource_id=$1 and event_type='admin.risk_flag.decided'`, [flagId]);
  assert.equal(event.metadata.ownerOverride, true);
  assert.equal(event.metadata.overriddenClaimOf, alice);
  // Claiming "isOwner" in code does not fool the database.
  const { flagId: other } = await customerFlag();
  await assert.rejects(risk.decideRiskFlag({ flagId: other, actorId: bob, isOwner: true, decision: "confirmed_fraud", note: NOTE }), /live claim/);
});

test("decided flags are final: no reopen, rewrite, re-claim or delete", { skip }, async () => {
  const { flagId } = await customerFlag();
  await risk.claimRiskFlag({ flagId, actorId: alice });
  await risk.decideRiskFlag({ flagId, actorId: alice, isOwner: false, decision: "confirmed_fraud", note: NOTE });
  await assert.rejects(sql.query(`update risk_flags set status='open', decision=null, resolution_note=null, resolved_by=null, resolved_at=null where id=$1`, [flagId]), /already decided/);
  await assert.rejects(sql.query(`update risk_flags set resolution_note='A different reason entirely' where id=$1`, [flagId]), /already decided/);
  await assert.rejects(sql.query(`delete from risk_flags where id=$1`, [flagId]), /append-only/);
  await assert.rejects(risk.claimRiskFlag({ flagId, actorId: bob }), /already been decided/);
  await assert.rejects(risk.decideRiskFlag({ flagId, actorId: olivia, isOwner: true, decision: "dismissed_false_positive", note: NOTE }), /already been decided/);
  // Status and decision must agree.
  const { flagId: other } = await customerFlag();
  await risk.claimRiskFlag({ flagId: other, actorId: alice });
  await assert.rejects(
    sql.query(`update risk_flags set status='dismissed', decision='confirmed_fraud', resolution_note=$2, resolved_by=$3 where id=$1`, [other, NOTE, alice]),
    /risk_flags_decision_consistent/);
  // A new occurrence after a decision opens a NEW flag; the decided record is untouched.
  const [{ subject_id }] = await sql.query(`select subject_id from risk_flags where id=$1`, [flagId]);
  await sql.query(`select evaluate_checkout_risk($1,$2,20000,20000,'order_ref_again')`, [subject_id, "b".repeat(64)]);
  const rows = await sql.query(`select id, status from risk_flags where subject_id=$1 order by created_at`, [subject_id]);
  assert.deepEqual(rows.map((r) => r.status), ["resolved", "open"]);
  assert.equal(rows[0].id, flagId);
});

test("confirming fraud suspends nobody", { skip }, async () => {
  const { user, flagId } = await customerFlag();
  const [before] = await sql.query(`select "moderationStatus" as s from "user" where id=$1`, [user]);
  await risk.claimRiskFlag({ flagId, actorId: alice });
  await risk.decideRiskFlag({ flagId, actorId: alice, isOwner: false, decision: "confirmed_fraud", note: NOTE });
  const [afterRow] = await sql.query(`select "moderationStatus" as s from "user" where id=$1`, [user]);
  assert.equal(afterRow.s, before.s);
});

test("every claim, release and decision is written to the audit history in order", { skip }, async () => {
  const { flagId } = await customerFlag();
  await risk.claimRiskFlag({ flagId, actorId: alice });
  await risk.releaseRiskFlag({ flagId, actorId: alice, isOwner: false });
  await risk.claimRiskFlag({ flagId, actorId: bob });
  await risk.claimRiskFlag({ flagId, actorId: bob }); // refresh
  await risk.decideRiskFlag({ flagId, actorId: bob, isOwner: false, decision: "dismissed_false_positive", note: NOTE });
  const events = await sql.query(
    `select event_type, actor_user_id, actor_role, metadata from audit_events where resource_type='risk_flag' and resource_id=$1 order by id`, [flagId]);
  assert.deepEqual(events.map((e) => [e.event_type, e.actor_user_id]), [
    ["admin.risk_flag.claimed", alice], ["admin.risk_flag.released", alice],
    ["admin.risk_flag.claimed", bob], ["admin.risk_flag.claimed", bob], ["admin.risk_flag.decided", bob],
  ]);
  assert.ok(events.every((e) => e.actor_role === "admin"));
  assert.equal(events[3].metadata.refreshed, true);
  assert.equal(events[4].metadata.decision, "dismissed_false_positive");
  assert.ok(!JSON.stringify(events.map((e) => e.metadata)).includes("@"), "no email addresses in audit metadata");
  const detail = await risk.getRiskFlagDetail(flagId);
  assert.equal(detail.history.length, 5);
  const history = await risk.listRiskFlags({ status: "decided" });
  const decided = history.find((f) => f.id === flagId);
  assert.equal(decided.resolverName, bob);
  assert.equal(decided.resolutionNote, NOTE);
});

test("a failed decision leaves no audit row and no change (same transaction)", { skip }, async () => {
  const { flagId } = await customerFlag();
  await risk.claimRiskFlag({ flagId, actorId: bob });
  await expireClaim(flagId);
  const [{ count: before }] = await sql.query(`select count(*)::int as count from audit_events where resource_id=$1`, [flagId]);
  await assert.rejects(risk.decideRiskFlag({ flagId, actorId: bob, isOwner: false, decision: "confirmed_fraud", note: NOTE }));
  const [{ count: afterCount }] = await sql.query(`select count(*)::int as count from audit_events where resource_id=$1`, [flagId]);
  assert.equal(afterCount, before);
  const [row] = await sql.query(`select status from risk_flags where id=$1`, [flagId]);
  assert.equal(row.status, "open");
});
