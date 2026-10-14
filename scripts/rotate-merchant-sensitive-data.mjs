#!/usr/bin/env node
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const active = process.env.ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY?.trim();
const previous = process.env.ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY_PREVIOUS?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl || !active || !previous) throw new Error("DATABASE_URL, active encryption key, and previous encryption key are required");

function parseKey(value, name) {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error(`${name} must encode 32 bytes`);
  return key;
}
const activeKey = parseKey(active, "ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY");
const previousKey = parseKey(previous, "ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY_PREVIOUS");

function decrypt(payload, key) {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== "v1") throw new Error("Unsupported encrypted data version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"));
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", activeKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
function rotate(value) {
  try { decrypt(value, activeKey); return null; } catch { /* value is encrypted with the previous key */ }
  return encrypt(decrypt(value, previousKey));
}

const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10000 });
let rotated = 0;
try {
  const merchants = await pool.query("select id,taxpayer_id_encrypted from merchants where taxpayer_id_encrypted is not null");
  for (const row of merchants.rows) {
    const next = rotate(row.taxpayer_id_encrypted);
    if (next) { await pool.query("update merchants set taxpayer_id_encrypted=$1,compliance_updated_at=now() where id=$2", [next, row.id]); rotated++; }
  }
  const connections = await pool.query("select id,credentials_encrypted,webhook_secret_encrypted from enterprise_catalog_connections");
  for (const row of connections.rows) {
    const credentials = row.credentials_encrypted ? rotate(row.credentials_encrypted) : null;
    const webhook = row.webhook_secret_encrypted ? rotate(row.webhook_secret_encrypted) : null;
    if (credentials || webhook) {
      await pool.query("update enterprise_catalog_connections set credentials_encrypted=coalesce($1,credentials_encrypted),webhook_secret_encrypted=coalesce($2,webhook_secret_encrypted),updated_at=now() where id=$3", [credentials, webhook, row.id]);
      rotated++;
    }
  }
  console.log(JSON.stringify({ ok: true, rotatedRows: rotated }));
} finally {
  await pool.end();
}
