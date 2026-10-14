#!/usr/bin/env node
/**
 * Production runtime entrypoint.
 *
 * Shared deployments run the repository migrator before the server starts.
 * The migrator uses a PostgreSQL advisory lock, verifies the immutable checksum
 * manifest, and applies each pending migration transactionally. This makes the
 * startup path portable to platforms without a pre-deploy hook.
 */
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const candidates = [
  ".output/server/index.mjs",
  ".vercel/output/functions/__server.func/index.mjs",
  ".vercel/output/server/index.mjs",
];

async function findServerEntry() {
  for (const candidate of candidates) {
    const path = resolve(process.cwd(), candidate);
    try {
      await access(path);
      return path;
    } catch {
      // Try the next generated output layout.
    }
  }
  throw new Error(`Nitro server entrypoint not found. Checked: ${candidates.join(", ")}`);
}

function forwardSignal(child, signal) {
  if (!child.killed) child.kill(signal);
}

async function main() {
  const packageCheck = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./validate-deployment-package.mjs", import.meta.url))],
    { stdio: "inherit", env: process.env },
  );
  if (packageCheck.error || packageCheck.status !== 0)
    throw new Error("Incomplete or corrupt deployment package; refusing to start");
  const validation = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./validate-startup-env.mjs", import.meta.url)), "--require-shared"],
    { stdio: "inherit", env: process.env },
  );
  if (validation.error || validation.status !== 0)
    throw new Error("Startup environment validation failed");
  const migration = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./migrate.mjs", import.meta.url))],
    { stdio: "inherit", env: process.env },
  );
  if (migration.error || migration.status !== 0)
    throw new Error("Database migration failed; refusing to start");
  const entry = await findServerEntry();
  console.log(`[startup] starting Nitro server: ${entry}`);

  const server = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: process.env,
  });

  const signals = ["SIGTERM", "SIGINT"];
  for (const signal of signals) {
    process.once(signal, () => forwardSignal(server, signal));
  }

  server.once("error", (err) => {
    console.error("[startup] server failed to start:", err);
    process.exitCode = 1;
  });

  server.once("exit", (code, signal) => {
    if (signal) {
      console.error(`[startup] server terminated by ${signal}`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 0;
    }
  });
}

main().catch((err) => {
  console.error("[startup] failed:", err?.message || err);
  process.exit(1);
});
