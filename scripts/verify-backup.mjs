#!/usr/bin/env node
/**
 * Backup verification (docs/CORE_GOVERNANCE_AND_DR.md).
 *
 * Usage:
 *   node scripts/verify-backup.mjs live            # check the live database + WAL archiver
 *   node scripts/verify-backup.mjs dump <file>     # validate a backup artifact before restore
 *
 * Exits non-zero on hard failures. Prints a JSON summary; never prints secrets.
 */
import fs from "node:fs";
import path from "node:path";

const [, , mode, target] = process.argv;
const summary = { mode, ok: true, checks: {}, warnings: [] };

function fail(check, message) {
  summary.ok = false;
  summary.checks[check] = { ok: false, message };
  console.error(`[verify-backup] FAIL ${check}: ${message}`);
}
function pass(check, detail) {
  summary.checks[check] = { ok: true, ...(detail ? { detail } : {}) };
}
function warn(message) {
  summary.warnings.push(message);
  console.error(`[verify-backup] WARN ${message}`);
}

// Tables whose survival is mandatory for financial/audit recovery (DR doc §7).
const CRITICAL_TABLES = [
  "payments",
  "payment_attempts",
  "payment_webhook_events",
  "orders",
  "order_items",
  "provider_refund_requests",
  "security_alerts",
];

async function verifyLive() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    fail("database_url", "DATABASE_URL is not configured.");
    return;
  }
  let client;
  try {
    // `pg` is a project dependency; resolved from the deployed workspace.
    const { default: pg } = await import("pg").catch(() => import("node:module").then(() => { throw new Error("pg module unavailable; run npm ci first"); }));
    client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
    await client.connect();
    pass("connect");
  } catch (error) {
    fail("connect", error instanceof Error ? error.message : String(error));
    return;
  }
  try {
    // WAL archiving health: the precondition for point-in-time recovery.
    const archiver = await client.query(
      `select archived_count, failed_count, last_archived_time from pg_stat_archiver`,
    ).catch(() => null);
    if (!archiver) {
      warn("pg_stat_archiver is unavailable (insufficient privileges or unsupported provider); cannot confirm WAL archiving.");
    } else {
      const row = archiver.rows[0] ?? {};
      if (Number(row.failed_count) > 0) warn(`WAL archiver has ${row.failed_count} failed archiving attempts.`);
      pass("wal_archiver", `archived=${row.archived_count} failed=${row.failed_count} last=${row.last_archived_time ?? "never"}`);
    }

    for (const table of CRITICAL_TABLES) {
      await client
        .query(`select count(*)::text as n from ${table}`)
        .then((r) => pass(`table:${table}`, `rows=${r.rows[0].n}`))
        .catch((error) => fail(`table:${table}`, error.message));
    }

    const freshness = await client.query(
      `select max(created_at) as latest from payments`,
    ).catch(() => null);
    if (freshness?.rows[0]?.latest) {
      const ageHours = (Date.now() - new Date(freshness.rows[0].latest).getTime()) / 3_600_000;
      if (ageHours > 24 * 7) warn(`Newest payment is ${Math.round(ageHours / 24)} days old; confirm this environment is expected to be idle.`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

function verifyDump(file) {
  if (!file) {
    fail("argument", "Missing dump file path.");
    return;
  }
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    fail("exists", `Backup file not found: ${resolved}`);
    return;
  }
  const size = fs.statSync(resolved).size;
  if (size === 0) {
    fail("empty", "Backup file is empty.");
    return;
  }
  pass("exists", `bytes=${size}`);

  const fd = fs.openSync(resolved, "r");
  const head = Buffer.alloc(5);
  fs.readSync(fd, head, 0, 5, 0);
  fs.closeSync(fd);
  if (head.toString("latin1") === "PGDMP") {
    pass("format", "PostgreSQL custom format (PGDMP header)");
    return;
  }
  // Plain SQL dump: validate schema content instead of trusting the extension.
  const sample = fs.readFileSync(resolved, "utf8");
  if (!/create table/i.test(sample)) {
    fail("content", "Not a PGDMP custom dump and contains no CREATE TABLE statements.");
    return;
  }
  const missing = CRITICAL_TABLES.filter((t) => !new RegExp(`create table[^;]*\\b${t}\\b`, "i").test(sample));
  if (missing.length) {
    fail("content", `Backup is missing critical tables: ${missing.join(", ")}`);
    return;
  }
  pass("format", "plain SQL dump with all critical tables present");
}

if (mode === "live") await verifyLive();
else if (mode === "dump") verifyDump(target);
else {
  console.error("Usage: node scripts/verify-backup.mjs live | dump <file>");
  process.exit(2);
}

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
