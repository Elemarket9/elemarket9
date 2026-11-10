// Upgrade safety for migration 0217 on real PostgreSQL: build a database at
// 0216, write representative wallet history (including the negative balance
// that 0216 allowed, defect R1, and withdrawals in flight), then apply 0217 with
// the production migrator and verify that every existing row is preserved.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/x_test npm run test:wallet:postgres
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";

const base = integrationDatabaseUrl();

test("0217 upgrades 0216 wallet history without changing it", { skip: !base && "PostgreSQL integration not enabled" }, async () => {
  const root = process.cwd();
  const work = mkdtempSync(path.join(os.tmpdir(), "elemarket-0216-"));
  const name = `${base.pathname.slice(1).replace(/_test$/, "")}_up${randomBytes(3).toString("hex")}_test`;
  const admin = new URL(base); admin.pathname = "/postgres";
  const url = new URL(base); url.pathname = `/${name}`;
  const exec = async (connection, fn) => { const c = new pg.Client({ connectionString: connection }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
  await exec(admin.toString(), (c) => c.query(`create database "${name}"`));
  try {
    // A copy of the release as it was at 0216.
    cpSync(path.join(root, "scripts"), path.join(work, "scripts"), { recursive: true });
    symlinkSync(path.join(root, "node_modules"), path.join(work, "node_modules"), "dir");
    cpSync(path.join(root, "migrations"), path.join(work, "migrations"), { recursive: true });
    rmSync(path.join(work, "migrations/0217_wallet_payout_safety.sql"));
    const manifest = JSON.parse(readFileSync(path.join(root, "migrations.sha256.json"), "utf8"));
    delete manifest["0217_wallet_payout_safety.sql"];
    writeFileSync(path.join(work, "migrations.sha256.json"), JSON.stringify(manifest, null, 2));
    const at0216 = spawnSync(process.execPath, ["scripts/migrate.mjs"], { cwd: work, env: { ...process.env, DATABASE_URL: url.toString() }, encoding: "utf8" });
    assert.equal(at0216.status, 0, at0216.stderr);
    assert.ok(!readdirSync(path.join(work, "migrations")).includes("0217_wallet_payout_safety.sql"));

    // Representative 0216 history: a sale, a release, a withdrawal reserved,
    // then a refund that drove available negative (allowed by 0216).
    const seeded = await exec(url.toString(), async (c) => {
      const m = `m_${randomBytes(4).toString("hex")}`;
      await c.query(`insert into merchants(id,name,category,status,verified,tier,address,city,neighborhood,lat,lon,catalog_categories,settlement_model)
                     values($1,'Upgrade Merchant','electronics','active',true,'merchant','1 Test St','Accra','Osu',5.6,-0.18,ARRAY['electronics'],'platform_wallet')`, [m]);
      await c.query(`insert into merchant_payout_accounts(id,merchant_id,rail,destination_ref,status,driver_key,display_hint,account_name,verified_at)
                     values($1,$2,'mobile_money','dst_upgrade','verified','signed-http','•••• 2222','Upgrade Merchant',now()-interval '3 days')`, [`mpa_${m}`, m]);
      const e = (type, bucket, amount, key, payout = null) => c.query(
        `insert into wallet_ledger_entries(merchant_id,entry_type,bucket,amount,payout_id,source_key) values($1,$2,$3,$4,$5,$6)`, [m, type, bucket, amount, payout, key]);
      await c.query("begin");
      await e("sale", "withheld", 95, "up:sale");
      await e("release", "withheld", -95, "up:rel:w"); await e("release", "available", 95, "up:rel:a");
      await c.query(`insert into wallet_payouts(id,merchant_id,destination_id,amount,fee,driver_key,idempotency_key,requested_by,status)
                     values('wpo_${"a".repeat(32)}',$1,$2,95,1,'signed-http','upgrade-key-000000001','user','processing')`, [m, `mpa_${m}`]);
      await e("payout_requested", "available", -95, "up:p1:a", `wpo_${"a".repeat(32)}`);
      await e("payout_requested", "processing", 95, "up:p1:p", `wpo_${"a".repeat(32)}`);
      await e("refund", "available", -40, "up:refund");
      await c.query("commit");
      const rows = (await c.query(`select id, merchant_id, entry_type, bucket, amount::text, source_key from wallet_ledger_entries order by id`)).rows;
      return { m, rows };
    });

    const upgrade = spawnSync(process.execPath, ["scripts/migrate.mjs"], { cwd: root, env: { ...process.env, DATABASE_URL: url.toString() }, encoding: "utf8" });
    assert.equal(upgrade.status, 0, upgrade.stderr || upgrade.stdout);
    assert.match(upgrade.stdout, /0217_wallet_payout_safety\.sql/);

    await exec(url.toString(), async (c) => {
      const after = (await c.query(`select id, merchant_id, entry_type, bucket, amount::text, source_key from wallet_ledger_entries order by id`)).rows;
      assert.deepEqual(after.slice(0, seeded.rows.length), seeded.rows, "existing ledger rows unchanged");
      const added = after.slice(seeded.rows.length);
      assert.deepEqual(added.map((r) => [r.entry_type, r.bucket, r.amount]), [["reclassification", "available", "40.00"], ["reclassification", "recovery", "-40.00"]]);
      const [b] = (await c.query(`select available::text, processing::text, recovery_due::text from merchant_wallet_balances where merchant_id=$1`, [seeded.m])).rows;
      assert.deepEqual(b, { available: "0.00", processing: "95.00", recovery_due: "40.00" });
      const [p] = (await c.query(`select status, destination_ref, rail from wallet_payouts`)).rows;
      assert.deepEqual(p, { status: "processing", destination_ref: "dst_upgrade", rail: "mobile_money" }, "in-flight payout kept and snapshotted");
      const [s] = (await c.query(`select wallet_reconciliation_summary()->'invariantViolations' as v`)).rows;
      assert.equal(Number(s.v), 0);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
    await exec(admin.toString(), (c) => c.query(`drop database if exists "${name}" with (force)`));
  }
});
