// Database operations proof on REAL PostgreSQL: the production migrator
// (fresh replay, repeat run, concurrent runners, a failing migration, tampered
// files) and a backup -> verify -> restore -> use drill.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test npm run test:db:postgres
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { checkout, configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";
import { deliverWithRiderOtp } from "../scripts/helpers/delivery-fixture.mjs";

const base = integrationDatabaseUrl();
const skip = !base && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
const root = process.cwd();
const migrationFiles = readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql"));

const admin = () => { const u = new URL(base); u.pathname = "/postgres"; return u.toString(); };
const dbUrl = (name) => { const u = new URL(base); u.pathname = `/${name}`; return u.toString(); };
const freshName = (tag) => `${base.pathname.slice(1).replace(/_test$/, "")}_${tag}${randomBytes(3).toString("hex")}_test`;
async function withClient(url, fn) { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return await fn(c); } finally { await c.end(); } }
const createDb = (name) => withClient(admin(), (c) => c.query(`create database "${name}" encoding 'UTF8' template template0`));
const dropDb = (name) => withClient(admin(), (c) => c.query(`drop database if exists "${name}" with (force)`));
const migrate = (url, cwd = root) => spawnSync(process.execPath, ["scripts/migrate.mjs"], { cwd, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
const migrateAsync = (url) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["scripts/migrate.mjs"], { cwd: root, env: { ...process.env, DATABASE_URL: url } });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  child.on("exit", (status) => resolve({ status, out }));
});

/** A fingerprint of the whole schema: tables, columns, constraints, indexes, functions, triggers. */
async function schemaFingerprint(url) {
  return withClient(url, async (c) => {
    const parts = await Promise.all([
      c.query(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by 1,2`),
      c.query(`select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace order by 1,2`),
      c.query(`select indexname, indexdef from pg_indexes where schemaname='public' order by 1`),
      c.query(`select proname, md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where nspname='public' and prokind='f' order by 1,2`),
      c.query(`select tgrelid::regclass::text, tgname, tgenabled from pg_trigger where not tgisinternal order by 1,2`),
    ]);
    // pg_restore re-parses CHECK constraints, and PostgreSQL then prints nested
    // AND groups flat: "(a AND b) AND c" comes back as "a AND b AND c". Same
    // logic, so constraint text is compared with grouping parentheses removed.
    parts[1].rows = parts[1].rows.map((r) => ({ ...r, pg_get_constraintdef: r.pg_get_constraintdef.replace(/[()]/g, "") }));
    return createHash("sha256").update(JSON.stringify(parts.map((p) => p.rows))).digest("hex");
  });
}

/** A copy of the release (scripts, migrations, manifest) that a test can alter. */
function releaseCopy() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "elemarket-release-"));
  cpSync(path.join(root, "scripts"), path.join(dir, "scripts"), { recursive: true });
  cpSync(path.join(root, "migrations"), path.join(dir, "migrations"), { recursive: true });
  cpSync(path.join(root, "migrations.sha256.json"), path.join(dir, "migrations.sha256.json"));
  symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
}

test("migrations: fresh replay applies every migration once; a repeat run changes nothing", { skip }, async () => {
  const name = freshName("mig");
  await createDb(name);
  try {
    const first = migrate(dbUrl(name));
    assert.equal(first.status, 0, first.stderr);
    const applied = await withClient(dbUrl(name), (c) => c.query(`select name, checksum from _migrations order by name`));
    assert.equal(applied.rows.length, migrationFiles.length, "every migration applied");
    assert.equal(new Set(applied.rows.map((r) => r.name)).size, migrationFiles.length, "each exactly once");
    assert.ok(applied.rows.every((r) => /^[a-f0-9]{64}$/.test(r.checksum)), "checksums recorded");
    const before = await schemaFingerprint(dbUrl(name));
    const again = migrate(dbUrl(name));
    assert.equal(again.status, 0, again.stderr);
    assert.equal(await schemaFingerprint(dbUrl(name)), before, "repeat run is a no-op");
    const count = await withClient(dbUrl(name), (c) => c.query(`select count(*)::int n from _migrations`));
    assert.equal(count.rows[0].n, migrationFiles.length);
  } finally { await dropDb(name); }
});

test("migrations: two migrators started together serialize on the advisory lock", { skip }, async () => {
  const name = freshName("race"), reference = freshName("ref");
  await createDb(name); await createDb(reference);
  try {
    const runs = await Promise.all([migrateAsync(dbUrl(name)), migrateAsync(dbUrl(name)), migrateAsync(dbUrl(name))]);
    assert.ok(runs.every((r) => r.status === 0), runs.map((r) => r.out.slice(-300)).join("\n"));
    const applied = await withClient(dbUrl(name), (c) => c.query(`select count(*)::int n, count(distinct name)::int d from _migrations`));
    assert.deepEqual(applied.rows[0], { n: migrationFiles.length, d: migrationFiles.length });
    assert.equal(migrate(dbUrl(reference)).status, 0);
    assert.equal(await schemaFingerprint(dbUrl(name)), await schemaFingerprint(dbUrl(reference)), "same schema as a single sequential run");
  } finally { await dropDb(name); await dropDb(reference); }
});

test("migrations: a failing migration rolls back completely and blocks later ones", { skip }, async () => {
  const name = freshName("fail");
  const dir = releaseCopy();
  await createDb(name);
  try {
    assert.equal(migrate(dbUrl(name), dir).status, 0);
    const before = await schemaFingerprint(dbUrl(name));
    // A valid statement followed by a failing one, then a later migration.
    const broken = "9998_injected_failure.sql", later = "9999_after_failure.sql";
    writeFileSync(path.join(dir, "migrations", broken), "create table injected_partial(id int);\ninsert into injected_partial values (1);\nselect 1/0;\n");
    writeFileSync(path.join(dir, "migrations", later), "create table injected_later(id int);\n");
    const manifest = JSON.parse(readFileSync(path.join(dir, "migrations.sha256.json"), "utf8"));
    for (const f of [broken, later]) manifest[f] = createHash("sha256").update(readFileSync(path.join(dir, "migrations", f), "utf8")).digest("hex");
    writeFileSync(path.join(dir, "migrations.sha256.json"), JSON.stringify(manifest, null, 2));
    const failed = migrate(dbUrl(name), dir);
    assert.notEqual(failed.status, 0, "migrator reports failure");
    await withClient(dbUrl(name), async (c) => {
      const tables = await c.query(`select to_regclass('injected_partial') as a, to_regclass('injected_later') as b`);
      assert.deepEqual(tables.rows[0], { a: null, b: null }, "no partial effect, later migration not run");
      const recorded = await c.query(`select count(*)::int n from _migrations where name like '999%'`);
      assert.equal(recorded.rows[0].n, 0);
    });
    assert.equal(await schemaFingerprint(dbUrl(name)), before, "schema exactly as before");
    // The advisory lock was released: a corrected release migrates normally.
    rmSync(path.join(dir, "migrations", broken));
    delete manifest[broken];
    writeFileSync(path.join(dir, "migrations.sha256.json"), JSON.stringify(manifest, null, 2));
    const fixed = migrate(dbUrl(name), dir);
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.ok(await withClient(dbUrl(name), (c) => c.query(`select to_regclass('injected_later') is not null as ok`)).then((r) => r.rows[0].ok));
  } finally { rmSync(dir, { recursive: true, force: true }); await dropDb(name); }
});

test("migrations: tampered or untracked files are refused before touching the database", { skip }, async () => {
  const name = freshName("tamper");
  const dir = releaseCopy();
  await createDb(name);
  try {
    assert.equal(migrate(dbUrl(name), dir).status, 0);
    const before = await schemaFingerprint(dbUrl(name));
    // 1. An already-applied migration edited after release.
    const target = path.join(dir, "migrations", migrationFiles[10]);
    const original = readFileSync(target, "utf8");
    writeFileSync(target, `${original}\n-- edited after release\n`);
    const edited = migrate(dbUrl(name), dir);
    assert.notEqual(edited.status, 0);
    assert.match(edited.stderr + edited.stdout, /checksum mismatch/);
    writeFileSync(target, original);
    // 2. An extra file that is not in the signed manifest.
    writeFileSync(path.join(dir, "migrations", "9997_untracked.sql"), "create table untracked_table(id int);");
    const untracked = migrate(dbUrl(name), dir);
    assert.notEqual(untracked.status, 0);
    assert.match(untracked.stderr + untracked.stdout, /checksum mismatch or untracked migration/);
    assert.equal(await schemaFingerprint(dbUrl(name)), before, "database untouched");
  } finally { rmSync(dir, { recursive: true, force: true }); await dropDb(name); }
});

test("backup drill: pg_dump -> verify-backup -> pg_restore --exit-on-error -> data, guards and app all intact", { skip, timeout: 600_000 }, async () => {
  const db = await createMigratedTestDatabase();
  const restoredName = freshName("restored");
  const work = mkdtempSync(path.join(os.tmpdir(), "elemarket-backup-"));
  const dump = path.join(work, "elemarket.dump");
  let harness, provider;
  try {
    // Representative live data through the real code: paid, delivered and released orders.
    configureSimulationEnv({ DATABASE_URL: db.url, ELEMARKET_WALLET_DESTINATION_COOLDOWN_HOURS: "0" });
    provider = installPaymentProviderMock();
    harness = await startHarness();
    const { sql } = harness;
    const payments = await harness.load("/src/modules/payments/public/payment.server.ts");
    const { handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts");
    const wallet = await harness.load("/src/modules/wallet/public/wallet.server.ts");
    const seed = await seedOrder(sql);
    await sql.query(`update product_variants set stock=50 where id=$1`, [seed.variant]);
    await sql.query(`update products set stock=50 where id=$1`, [seed.product]);
    await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
    await wallet.enableWalletForMerchant(seed.merchant, "backup-drill");
    for (let i = 0; i < 3; i++) {
      const order = await checkout(sql, seed);
      const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: seed.user });
      provider.pay(intent.providerReference);
      const raw = JSON.stringify({ event: "charge.success", data: { id: 900 + i, reference: intent.providerReference, amount: 11500, currency: "GHS" } });
      await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
      await deliverWithRiderOtp(sql, { orderId: order.orderId, at: new Date(Date.now() - 8 * 24 * 3600e3) }); // past the 7-day return window
    }
    await sql.query(`select release_matured_wallet_funds(100)`);
    provider.restore(); provider = undefined;
    await harness.close(); harness = undefined;

    const tableFingerprints = (url) => withClient(url, async (c) => {
      const tables = (await c.query(`select tablename from pg_tables where schemaname='public' order by 1`)).rows.map((r) => r.tablename);
      const out = {};
      for (const t of tables) {
        const r = await c.query(`select count(*)::int n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') h from "${t}" x`);
        out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
      }
      return out;
    });
    const source = await tableFingerprints(db.url);
    assert.ok(Number(source.orders.split(":")[0]) >= 4 && Number(source.wallet_ledger_entries.split(":")[0]) >= 6, "representative data present");

    // Backup exactly as docs/deployment.md and compose.yaml do.
    const dumped = spawnSync("pg_dump", ["-Fc", "-f", dump, db.url], { encoding: "utf8" });
    assert.equal(dumped.status, 0, dumped.stderr);
    const verified = spawnSync(process.execPath, ["scripts/verify-backup.mjs", "dump", dump], { cwd: root, encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    assert.equal(JSON.parse(verified.stdout.slice(verified.stdout.indexOf("{"))).ok, true);

    // Restore into a brand-new database, failing on the first error.
    await createDb(restoredName);
    const restored = spawnSync("pg_restore", ["--exit-on-error", "--no-owner", "-d", dbUrl(restoredName), dump], { encoding: "utf8" });
    assert.equal(restored.status, 0, restored.stderr);

    assert.deepEqual(await tableFingerprints(dbUrl(restoredName)), source, "every table, every row identical");
    assert.equal(await schemaFingerprint(dbUrl(restoredName)), await schemaFingerprint(db.url), "schema, functions and triggers identical");
    const remigrate = migrate(dbUrl(restoredName));
    assert.equal(remigrate.status, 0, remigrate.stderr);

    await withClient(dbUrl(restoredName), async (c) => {
      // Guards survived the restore.
      await assert.rejects(c.query(`update wallet_ledger_entries set amount = amount * 2`), /append-only/);
      await assert.rejects(c.query(`update orders set customer_received_at = now() where customer_received_at is not null`), /immutable/);
      const [{ s }] = (await c.query(`select wallet_reconciliation_summary() as s`)).rows;
      assert.equal(Number(s.invariantViolations), 0);
      // And the restored database keeps working: new money moves still pass the invariants.
      await c.query(`select release_matured_wallet_funds(100)`);
    });
  } finally {
    provider?.restore();
    await harness?.close();
    rmSync(work, { recursive: true, force: true });
    await dropDb(restoredName);
    await db.drop();
  }
});
