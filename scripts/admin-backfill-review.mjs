#!/usr/bin/env node
/** Read-only verification of admin identities before migration 0183. */
import { createHash, timingSafeEqual } from "node:crypto";

export function adminSetFingerprint(rows) {
  return createHash("sha256").update(
    rows.map(({id, email}) => `${id}\t${String(email).toLowerCase()}`).sort().join("\n"),
  ).digest("hex");
}

export function approvedAdminSet(rows, expected) {
  if (!rows.length) return true;
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) return false;
  return timingSafeEqual(Buffer.from(adminSetFingerprint(rows), "hex"), Buffer.from(expected, "hex"));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const {default: pg} = await import("pg");
  const pool = new pg.Pool({ connectionString:process.env.DATABASE_URL,max:1 });
  try {
    const rows = (await pool.query(`select id,email from "user" where role='admin' order by id`)).rows;
    console.log(`Legacy administrative accounts to receive initial owner rights: ${rows.length}`);
    for (const row of rows) console.log(`- ${row.id} <${row.email}>`);
    console.log(`SHA-256 approval fingerprint: ${adminSetFingerprint(rows)}`);
    console.log("Only approve the exact set after independently checking every identity.");
  } finally { await pool.end(); }
}
