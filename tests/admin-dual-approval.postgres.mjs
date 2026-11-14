// Two-person approval on REAL PostgreSQL (migration 0221).
// The rule "the approver must be a different person" is enforced by the
// database, so it holds even if application code is bypassed or buggy.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test npm run test:db:postgres
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { checkout, configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
let db, harness, sql, dual, provider, payments, handlePaymentWebhook;
const alice = `dap_alice_${randomBytes(4).toString("hex")}`;
const bob = `dap_bob_${randomBytes(4).toString("hex")}`;

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url });
  provider = installPaymentProviderMock();
  harness = await startHarness();
  sql = harness.sql;
  dual = await harness.load("/src/modules/administration/internal/dual-approval.server.ts");
  payments = await harness.load("/src/modules/payments/public/payment.server.ts");
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));
  for (const id of [alice, bob]) {
    await sql.query(`insert into "user"(id,name,email,"emailVerified",role) values($1,$1,$2,true,'admin')`, [id, `${id}@example.test`]);
  }
});
after(async () => {
  if (!enabled) return;
  provider?.restore();
  await harness?.close();
  await db?.drop();
});

const request = (subjectId, extra = {}) => dual.createDualApproval(sql, {
  action: "order_refund", subjectId, amount: "2500.00", currency: "GHS", payload: { paymentId: "pay_x" },
  capability: "admin.finance.refunds", requestedBy: alice, reason: "Customer received a damaged television", ...extra,
});

test("the database refuses a self-approval even when application code is bypassed", { skip }, async () => {
  const { approvalId } = await request("order_db_guard");
  await assert.rejects(
    sql.query(`update admin_dual_approvals set status='approved', decided_by=$2, decided_at=now() where id=$1`, [approvalId, alice]),
    /admin_dual_approvals_four_eyes/,
  );
});

test("the requester cannot approve; a different administrator can, exactly once", { skip }, async () => {
  const { approvalId } = await request("order_two_people");
  await assert.rejects(dual.decideDualApproval({ approvalId, deciderId: alice, decision: "approve", note: "Approving my own request" }), /second administrator/);
  const row = await dual.decideDualApproval({ approvalId, deciderId: bob, decision: "approve", note: "Checked the order and the photos" });
  assert.equal(row.status, "approved");
  await assert.rejects(dual.decideDualApproval({ approvalId, deciderId: bob, decision: "approve", note: "Second click on approve" }), /already been decided/);
  await dual.recordDualApprovalOutcome(approvalId, { ok: true });
  const [stored] = await sql.query(`select status, requested_by, decided_by from admin_dual_approvals where id=$1`, [approvalId]);
  assert.deepEqual(stored, { status: "executed", requested_by: alice, decided_by: bob });
});

test("decided requests are tamper-proof and the record can't be deleted", { skip }, async () => {
  const { approvalId } = await request("order_tamper");
  await dual.decideDualApproval({ approvalId, deciderId: bob, decision: "reject", note: "Refund not justified by evidence" });
  await assert.rejects(sql.query(`update admin_dual_approvals set amount=1 where id=$1`, [approvalId]), /immutable/);
  await assert.rejects(sql.query(`update admin_dual_approvals set status='approved' where id=$1`, [approvalId]), /already final/);
  await assert.rejects(sql.query(`delete from admin_dual_approvals where id=$1`, [approvalId]), /append-only/);
});

test("one open request per order: no parallel duplicates", { skip }, async () => {
  await request("order_duplicate");
  await assert.rejects(request("order_duplicate"), /already waiting/);
});

test("expired requests cannot be approved and do not block a fresh request", { skip }, async () => {
  const { approvalId } = await request("order_expired");
  await sql.query(`alter table admin_dual_approvals disable trigger admin_dual_approvals_guard`);
  await sql.query(`update admin_dual_approvals set expires_at=now()-interval '1 minute' where id=$1`, [approvalId]);
  await sql.query(`alter table admin_dual_approvals enable trigger admin_dual_approvals_guard`);
  await assert.rejects(dual.decideDualApproval({ approvalId, deciderId: bob, decision: "approve", note: "Approving an old request" }), /expired/);
  const again = await request("order_expired");
  assert.notEqual(again.approvalId, approvalId);
});

test("only the requester can withdraw a pending request", { skip }, async () => {
  const { approvalId } = await request("order_withdraw");
  await assert.rejects(dual.cancelDualApproval({ approvalId, actorId: bob }), /Only the person who submitted/);
  await dual.cancelDualApproval({ approvalId, actorId: alice });
  const [stored] = await sql.query(`select status from admin_dual_approvals where id=$1`, [approvalId]);
  assert.equal(stored.status, "cancelled");
});

test("every request and decision is written to the audit history", { skip }, async () => {
  const { approvalId } = await request("order_audit");
  await dual.decideDualApproval({ approvalId, deciderId: bob, decision: "approve", note: "Checked against provider dashboard" });
  const events = await sql.query(`select event_type from audit_events where resource_id=$1 order by id`, [approvalId]);
  assert.deepEqual(events.map((e) => e.event_type), ["admin.dual_approval.requested", "admin.dual_approval.approved"]);
});

test("payout officers are a separate permission from commission policy", { skip }, async () => {
  await sql.query(`insert into admin_roles(role_key,display_name) values('payouts_officer','Payouts Officer')`);
  await sql.query(`insert into admin_role_permissions(role_key,capability) values('payouts_officer','admin.finance.payouts')`);
  await assert.rejects(
    sql.query(`insert into admin_role_permissions(role_key,capability) values('payouts_officer','admin.finance.anything')`),
    /admin_role_permissions_capability_check/,
  );
});

// Regression (migration 0222): the function bound the order through a column
// that never existed (orders.payment_id), so every refund preparation raised
// 'column "payment_id" does not exist': customer cancellations and admin refunds.
test("a paid order can be prepared for refund", { skip }, async () => {
  const seed = await seedOrder(sql);
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
  await sql.query(`update product_variants set stock=10 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=10 where id=$1`, [seed.product]);
  const order = await checkout(sql, seed);
  const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: seed.user });
  provider.pay(intent.providerReference);
  const raw = JSON.stringify({ event: "charge.success", data: { id: 77_001, reference: intent.providerReference, amount: Math.round(Number(order.grandTotal) * 100), currency: "GHS" } });
  await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
  const [{ result }] = await sql.query(`select prepare_provider_refund_for_payment($1,$2,'customer_order_cancellation') as result`, [order.paymentId, seed.user]);
  assert.match(result.requestId, /^prr_/);
  const [after] = await sql.query(`select status from orders where id=$1`, [order.orderId]);
  assert.equal(after.status, "refund_pending");
  const [again] = await sql.query(`select prepare_provider_refund_for_payment($1,$2,'customer_order_cancellation') as result`, [order.paymentId, seed.user]);
  assert.equal(again.result.requestId, result.requestId, "idempotent: no second refund");
});
