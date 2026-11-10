#!/usr/bin/env node
// Registry signature and provenance check (`npm audit signatures`) that keeps
// its full strictness but tolerates one known-transient failure: the registry
// briefly not serving the public key for a package's provenance attestation
// ("has attestations but no corresponding public key(s) can be found",
// EMISSINGSIGNATUREKEY). Only that error is retried, a bounded number of times.
// Invalid signatures, missing signatures and every other error fail at once,
// and the transient error still fails if it persists.
import { spawnSync } from "node:child_process";

const ATTEMPTS = Number(process.env.SIGNATURE_AUDIT_ATTEMPTS ?? 4);
const DELAY_MS = Number(process.env.SIGNATURE_AUDIT_DELAY_MS ?? 20_000);
const TRANSIENT = /has attestations but no corresponding public key\(s\) can be found/;

export function classify(output, status) {
  if (status === 0) return "ok";
  const errors = output.split("\n").filter((line) => /^npm error /.test(line) && !/complete log of this run/.test(line));
  const meaningful = errors.filter((line) => !/^npm error code EMISSINGSIGNATUREKEY$/.test(line.trim()));
  if (meaningful.length > 0 && meaningful.every((line) => TRANSIENT.test(line))) return "transient";
  return "fail";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const run = spawnSync("npm", ["audit", "signatures"], { encoding: "utf8" });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const verdict = classify(output, run.status);
    process.stdout.write(output);
    if (verdict === "ok") return 0;
    if (verdict === "fail") return run.status || 1;
    if (attempt < ATTEMPTS) {
      console.error(`[audit-signatures] registry key not yet available (attempt ${attempt}/${ATTEMPTS}); retrying in ${DELAY_MS / 1000}s`);
      await sleep(DELAY_MS);
    }
  }
  console.error("[audit-signatures] provenance key still unavailable after retries; failing closed");
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
