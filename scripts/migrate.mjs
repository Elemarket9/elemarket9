#!/usr/bin/env node
/**
 * Deploy-time database migrator (node-postgres, `pg`).
 *
 * Runs as an explicit deployment step (`npm run db:migrate`), applying pending files
 * in ../migrations to DATABASE_URL. Each file is applied in one transaction and
 * recorded in a `_migrations` table, so it runs once and is safe to re-run.
 *
 * The read is non-recursive, so the opt-in auth schema under migrations/auth/
 * is not applied to an app that never asked for sign-in.
 *
 * No DATABASE_URL -> skip; production deployment validation must reject missing DATABASE_URL.
 */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pendingMigrations } from "./migration-plan.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log("[migrate] DATABASE_URL not set — skipping (the PGLite fallback migrates itself).");
  process.exit(0);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations.sha256.json");

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function main() {
  let entries;
  try {
    entries = await readdir(migrationsDir);
  } catch {
    console.log("[migrate] no migrations/ directory — nothing to do.");
    return;
  }
  // An app with no schema of its own must not pay for a database connection.
  if (pendingMigrations(entries, []).length === 0) {
    console.log("[migrate] no migrations — nothing to do.");
    return;
  }

  const packageManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const name of Object.keys(packageManifest)) {
    if (!entries.includes(name))
      throw new Error(`[migrate] manifest contains missing migration: ${name}`);
    if (packageManifest[name] !== sha256(await readFile(join(migrationsDir, name), "utf8")))
      throw new Error(`[migrate] migration checksum mismatch: ${name}`);
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const MIGRATION_LOCK_KEY = 738214901;
  let lockHeld = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    lockHeld = true;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const migrationFiles = entries
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));
    for (const name of migrationFiles) {
      const text = await readFile(join(migrationsDir, name), "utf8");
      if (manifest[name] !== sha256(text))
        throw new Error(`[migrate] migration checksum mismatch or untracked migration: ${name}`);
    }
    await client.query(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), checksum TEXT)",
    );
    await client.query("ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
    const appliedRows = (await client.query("SELECT name, checksum FROM _migrations")).rows;
    for (const row of appliedRows) {
      const expected = manifest[row.name];
      if (!expected)
        throw new Error(`[migrate] applied migration is absent from manifest: ${row.name}`);
      if (row.checksum && row.checksum !== expected)
        throw new Error(`[migrate] applied migration checksum drift detected: ${row.name}`);
      if (!row.checksum)
        await client.query("UPDATE _migrations SET checksum=$1 WHERE name=$2", [
          expected,
          row.name,
        ]);
    }
    const applied = appliedRows.map((r) => r.name);

    let count = 0;
    const pending = pendingMigrations(entries, applied);
    // 0183 originally granted owner status to ALL legacy admin identities.
    // Historical migration is immutable; fail BEFORE applying it unless the
    // operator has approved the exact current legacy-admin identity set.
    if (pending.some(({name}) => name.startsWith("0183_"))) {
      const userTable = (await client.query(`select to_regclass('"user"') as name`)).rows[0]?.name;
      const accounts = userTable ? (await client.query(`select id,email from "user" where role='admin' order by id`)).rows : [];
      const { approvedAdminSet, adminSetFingerprint } = await import("./admin-backfill-review.mjs");
      if (!approvedAdminSet(accounts, process.env.ELEMARKET_APPROVED_LEGACY_ADMINS_SHA256)) {
        throw new Error(`[migrate] refusing legacy admin-owner backfill for ${accounts.length} accounts. ` +
          `Review identities with node scripts/admin-backfill-review.mjs; ` +
          `after independent review set ELEMARKET_APPROVED_LEGACY_ADMINS_SHA256=${adminSetFingerprint(accounts)}.`);
      }
    }
    for (const { name } of pending) {
      const text = await readFile(join(migrationsDir, name), "utf8");
      try {
        await client.query("BEGIN");
        // pg's simple-query protocol runs a whole multi-statement file at once.
        await client.query(text);
        await client.query("INSERT INTO _migrations (name, checksum) VALUES ($1, $2)", [
          name,
          sha256(text),
        ]);
        await client.query("COMMIT");
      } catch (err) {
        console.error(`[migrate] error applying ${name}`);
        try {
          await client.query("ROLLBACK");
        } catch {
          // ROLLBACK fails when the connection died — keep the original error.
        }
        throw err;
      }
      console.log(`[migrate] applied ${name}`);
      count += 1;
    }
    console.log(
      count ? `[migrate] done — ${count} migration(s) applied.` : "[migrate] up to date.",
    );
  } finally {
    if (lockHeld) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      } catch {
        /* connection teardown releases session locks */
      }
    }
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err?.message || err);
  // pg errors carry the context needed to debug a bad SQL file.
  for (const key of ["code", "detail", "hint", "position", "where"]) {
    if (err?.[key] != null) console.error(`[migrate]   ${key}: ${err[key]}`);
  }
  process.exit(1);
});
