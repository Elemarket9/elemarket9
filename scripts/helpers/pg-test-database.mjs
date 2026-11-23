// Disposable PostgreSQL databases for integration tests.
// Requires RUN_DB_INTEGRATION=1 and ELEMARKET_INTEGRATION_DATABASE_URL pointing at
// a server you control, with a database name ending in _test. Each call creates a
// fresh <name>_<random>_test database, applies every migration with the production
// migrator, and returns its URL plus a drop() that destroys it.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function integrationDatabaseUrl() {
  if (process.env.RUN_DB_INTEGRATION !== "1") return null;
  const raw = process.env.ELEMARKET_INTEGRATION_DATABASE_URL;
  if (!raw) throw new Error("ELEMARKET_INTEGRATION_DATABASE_URL is required with RUN_DB_INTEGRATION=1");
  const url = new URL(raw);
  if (!/_test$/.test(url.pathname.slice(1))) throw new Error("Integration database name must end in _test");
  return url;
}

export async function createMigratedTestDatabase(base = integrationDatabaseUrl()) {
  if (!base) throw new Error("PostgreSQL integration is not enabled");
  const name = `${base.pathname.slice(1).replace(/_test$/, "")}_${randomBytes(4).toString("hex")}_test`;
  const admin = new URL(base); admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`create database "${name}" encoding 'UTF8' template template0`);
  await client.end();
  const url = new URL(base); url.pathname = `/${name}`;
  const migrated = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
    cwd: root, env: { ...process.env, DATABASE_URL: url.toString() }, encoding: "utf8",
  });
  if (migrated.status !== 0) throw new Error(`Migration failed:\n${migrated.stdout}\n${migrated.stderr}`);
  return {
    url: url.toString(),
    async drop() {
      const c = new pg.Client({ connectionString: admin.toString() });
      await c.connect();
      await c.query(`drop database if exists "${name}" with (force)`);
      await c.end();
    },
  };
}
