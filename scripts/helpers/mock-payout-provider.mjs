// SIMULATED payout provider adapter, for tests only. No money moves.
//
// Loaded through the real driver registry as an allowlisted module
// (ELEMARKET_PAYOUT_DRIVER_<KEY>_MODULE). Its "provider side" lives in the
// sim_provider schema of the test database, so several worker processes and a
// crashed-and-restarted process all see the same simulated provider.
//
// Per driver key:
//   SIM_PAYOUT_<KEY>_CAPS  comma list of: idempotent, lookup, webhooks, listing, validation
// Faults are queued in sim_provider.faults and consumed one per matching call:
//   create:  reject | timeout_before | timeout_after | crash_after | fail_final | paid_final | duplicate
//   lookup:  unavailable
import { createHmac } from "node:crypto";
import pg from "pg";

// One pool per process, shared by every copy of this module (the app's bundler
// and the test runner each load their own copy).
const shared = (globalThis.__simPayoutProvider__ ??= { pool: undefined, ready: undefined });
async function db() {
  if (!shared.pool) {
    shared.pool = new pg.Pool({ connectionString: process.env.SIM_PROVIDER_DATABASE_URL, max: 4 });
    shared.pool.on("error", () => undefined);
    const pool = shared.pool;
    shared.ready = pool
      .query(`create schema if not exists sim_provider;
      create table if not exists sim_provider.transfers(
        id bigserial primary key, driver_key text not null, payout_id text not null, idempotency_key text not null,
        reference text not null unique, amount text not null, destination_ref text not null,
        status text not null default 'processing', created_at timestamptz not null default now());
      create table if not exists sim_provider.faults(
        id bigserial primary key, driver_key text not null, op text not null, mode text not null, consumed boolean not null default false);`)
      .catch((e) => { if (!/already exists|duplicate key/.test(e.message)) throw e; });
  }
  await shared.ready;
  return shared.pool;
}

class SimulatedProviderError extends Error {
  constructor(message, rejected = false) { super(message); this.name = "PayoutProviderError"; this.rejected = rejected; }
}

async function takeFault(key, op) {
  const { rows } = await (await db()).query(
    `update sim_provider.faults set consumed=true where id=(select id from sim_provider.faults
       where driver_key=$1 and op=$2 and not consumed order by id limit 1 for update skip locked) returning mode`, [key, op]);
  return rows[0]?.mode ?? null;
}

const webhookSecret = (key) => `sim-webhook-secret-${key}-0123456789abcdef`;

export function createPayoutDriver({ key }) {
  const env = `SIM_PAYOUT_${key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const caps = new Set((process.env[`${env}_CAPS`] ?? "idempotent,lookup,webhooks,listing,validation").split(",").map((s) => s.trim()).filter(Boolean));
  // Each simulated provider signs with its own secret, as real providers do.
  const secret = webhookSecret(key);
  const toState = (r) => r && { providerReference: r.reference, status: r.status, amount: r.amount, currency: "GHS" };
  const driver = {
    key,
    simulated: true,
    capabilities: {
      idempotentInitiation: caps.has("idempotent"),
      statusLookup: caps.has("lookup"),
      webhooks: caps.has("webhooks"),
      reconciliationListing: caps.has("listing"),
      destinationValidation: caps.has("validation"),
      feeQuote: false,
    },
    webhookSignatureHeaders: ["x-sim-signature"],
    async quoteFee() { return "1.00"; },
    async registerDestination(input) {
      const digits = input.accountNumber.replace(/\D/g, "");
      return { destinationRef: `simdst_${digits}`, resolvedAccountName: input.accountName, verified: caps.has("validation") };
    },
    async createPayout(cmd) {
      const q = await db();
      const fault = await takeFault(key, "create");
      if (fault === "reject") throw new SimulatedProviderError("SIMULATED: provider refused the transfer", true);
      if (fault === "timeout_before") throw new SimulatedProviderError("SIMULATED: timeout before the provider received it");
      if (caps.has("idempotent")) {
        const { rows } = await q.query(`select * from sim_provider.transfers where driver_key=$1 and idempotency_key=$2 order by id limit 1`, [key, cmd.idempotencyKey]);
        if (rows[0]) return toState(rows[0]);
      }
      const insert = async (suffix = "") => (await q.query(
        `insert into sim_provider.transfers(driver_key,payout_id,idempotency_key,reference,amount,destination_ref,status)
         values($1,$2,$3,$4,$5,$6,$7) returning *`,
        [key, cmd.payoutId, cmd.idempotencyKey, `simref_${key}_${cmd.payoutId.slice(4, 16)}_${Date.now()}${suffix}_${Math.random().toString(36).slice(2, 6)}`,
          cmd.amount, cmd.destinationRef, fault === "fail_final" ? "failed" : fault === "paid_final" ? "paid" : "processing"])).rows[0];
      const row = await insert();
      if (fault === "duplicate") await insert("_dup");
      if (fault === "timeout_after") throw new SimulatedProviderError("SIMULATED: provider accepted but the response was lost");
      if (fault === "crash_after") { process.stderr.write("SIMULATED CRASH after provider accepted the transfer\n"); process.exit(137); }
      return toState(row);
    },
    async getPayout(payoutId) {
      if (!caps.has("lookup")) throw new SimulatedProviderError("SIMULATED: this provider has no status lookup");
      if ((await takeFault(key, "lookup")) === "unavailable") throw new SimulatedProviderError("SIMULATED: status lookup unavailable");
      const { rows } = await (await db()).query(`select * from sim_provider.transfers where driver_key=$1 and payout_id=$2 order by id limit 1`, [key, payoutId]);
      return toState(rows[0]) ?? null;
    },
    async listPayouts(since) {
      const { rows } = await (await db()).query(
        `select * from sim_provider.transfers where driver_key=$1 and created_at >= $2 order by id`, [key, since]);
      return rows.map((r) => ({ payoutId: r.payout_id, providerReference: r.reference, status: r.status, amount: r.amount, currency: "GHS", destinationRef: r.destination_ref }));
    },
    async verifyWebhook(raw, signature) {
      return Boolean(signature) && signature === createHmac("sha256", secret).update(raw).digest("hex");
    },
    async parseWebhook(raw) {
      const body = JSON.parse(raw);
      return { payoutId: body.payoutId, providerReference: body.providerReference ?? null, status: body.status };
    },
  };
  return driver;
}

/** Test-side controls for the simulated provider. */
export const simulatedProvider = {
  async injectFault(key, op, mode, times = 1) {
    for (let i = 0; i < times; i++) await (await db()).query(`insert into sim_provider.faults(driver_key,op,mode) values($1,$2,$3)`, [key, op, mode]);
  },
  async finish(payoutId, status) {
    await (await db()).query(`update sim_provider.transfers set status=$2 where payout_id=$1`, [payoutId, status]);
  },
  async transfers(payoutId) {
    return (await (await db()).query(`select * from sim_provider.transfers where payout_id=$1 order by id`, [payoutId])).rows;
  },
  async allTransfers() { return (await (await db()).query(`select * from sim_provider.transfers order by id`)).rows; },
  signWebhook(raw, key = "mocka") { return createHmac("sha256", webhookSecret(key)).update(raw).digest("hex"); },
  async close() { const p = shared.pool; shared.pool = undefined; await p?.end().catch(() => undefined); },
};
