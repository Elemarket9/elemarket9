// Every scheduled job, called the way the production scheduler calls it, on REAL
// PostgreSQL. Regression for two defects found in the full-stack rehearsal:
//   - the enterprise workers refused the scheduler's signed request (they checked
//     only ELEMARKET_ENTERPRISE_SYNC_SECRET, which must differ from CRON_SECRET),
//     so they never ran;
//   - the order-outbox claim query used `'ed_' + text`, invalid SQL, so the job
//     failed on every run even with nothing queued.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test npm run test:db:postgres
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { configureSimulationEnv, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";
import { JOBS, signedHeaders } from "../scripts/scheduler-core.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
const CRON_SECRET = randomBytes(32).toString("hex");
const ENTERPRISE_SECRET = randomBytes(32).toString("hex");
let db, harness, sql, auth;

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url, CRON_SECRET, ELEMARKET_ENTERPRISE_SYNC_SECRET: ENTERPRISE_SECRET });
  harness = await startHarness();
  sql = harness.sql;
  auth = await harness.load("/src/lib/security/internal-job-auth.server.ts");
});
after(async () => {
  if (!enabled) return;
  await harness?.close();
  await db?.drop();
});

const routeFile = (path) => `/src/routes/api.internal.${path.replace("/api/internal/", "")}.ts`;
const schedulerRequest = (path, headers = signedHeaders({ secret: CRON_SECRET, path })) =>
  new Request(`http://app:8080${path}`, { method: "GET", headers });
/** Sign like the enterprise HMAC protocol, with any key and method. */
function hmacHeaders(secret, method, path) {
  const timestamp = String(Date.now()), nonce = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update("").digest("hex");
  const signature = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${method}.${path}.${hash}`).digest("hex");
  return { "x-elemarket-sync-timestamp": timestamp, "x-elemarket-sync-nonce": nonce, "x-elemarket-sync-signature": signature, "x-elemarket-body-sha256": hash };
}

test("every scheduled job accepts the scheduler's signed request and succeeds", { skip }, async () => {
  for (const job of JOBS) {
    const { Route } = await harness.load(routeFile(job.path));
    const response = await Route.options.server.handlers.GET({ request: schedulerRequest(job.path) });
    assert.equal(response.status, 200, `${job.path} answered HTTP ${response.status}: ${await response.text()}`);
  }
});

test("the scheduler credential stays narrow: no replay, no POST, no wrong key, no other routes", { skip }, async () => {
  const path = "/api/internal/enterprise-order-outbox";
  const headers = signedHeaders({ secret: CRON_SECRET, path });
  assert.equal(await auth.authorizeScheduledJobRequest(schedulerRequest(path, headers), ENTERPRISE_SECRET), true);
  assert.equal(await auth.authorizeScheduledJobRequest(schedulerRequest(path, headers), ENTERPRISE_SECRET), false, "replayed nonce");
  const post = new Request(`http://app:8080${path}`, { method: "POST", headers: hmacHeaders(CRON_SECRET, "POST", path) });
  assert.equal(await auth.authorizeScheduledJobRequest(post, ENTERPRISE_SECRET), false, "scheduler key on POST");
  const wrong = schedulerRequest(path, hmacHeaders(randomBytes(32).toString("hex"), "GET", path));
  assert.equal(await auth.authorizeScheduledJobRequest(wrong, ENTERPRISE_SECRET), false, "unknown key");
  // Manual callers with the enterprise secret keep working, on GET and POST.
  assert.equal(await auth.authorizeScheduledJobRequest(schedulerRequest(path, hmacHeaders(ENTERPRISE_SECRET, "GET", path)), ENTERPRISE_SECRET), true);
  const manual = new Request(`http://app:8080${path}`, { method: "POST", headers: hmacHeaders(ENTERPRISE_SECRET, "POST", path) });
  assert.equal(await auth.authorizeScheduledJobRequest(manual, ENTERPRISE_SECRET), true);
  // A route outside the schedule never accepts the scheduler key.
  const other = "/api/enterprise/catalog/sync";
  const offSchedule = new Request(`http://app:8080${other}`, { method: "GET", headers: hmacHeaders(CRON_SECRET, "GET", other) });
  assert.equal(await auth.authorizeInternalHmacRequest(offSchedule, ENTERPRISE_SECRET), false);
  assert.equal(await auth.authorizeScheduledJobRequest(offSchedule, ENTERPRISE_SECRET), false);
});

test("a queued enterprise order event is claimed and retried with backoff, not lost", { skip }, async () => {
  const seed = await seedOrder(sql);
  const id = `eoo_${randomBytes(8).toString("hex")}`;
  await sql.query(
    `insert into enterprise_order_outbox(id,merchant_id,order_id,event_type,idempotency_key,payload)
     values($1,$2,$3,'order.created',$1,'{}'::jsonb)`, [id, seed.merchant, seed.order]);
  const integration = await harness.load("/src/modules/merchants/public/enterprise-integration.server.ts");
  const result = await integration.deliverEnterpriseOrderOutbox(10);
  assert.deepEqual(result, { claimed: 1, sent: 0, retried: 1, dead: 0 });
  const [row] = await sql.query(`select status, attempts, last_error, next_attempt_at > now() as backed_off, delivery_attempt_id from enterprise_order_outbox where id=$1`, [id]);
  assert.equal(row.status, "retry");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /endpoint is not configured/);
  assert.equal(row.backed_off, true);
  assert.match(row.delivery_attempt_id, /^ed_[a-f0-9]{32}$/);
  const [attempt] = await sql.query(`select status from enterprise_order_delivery_attempts where id=$1`, [row.delivery_attempt_id]);
  assert.equal(attempt.status, "failed");
});
