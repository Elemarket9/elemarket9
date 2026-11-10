import { createHash } from "node:crypto";
import { getSql } from "@/lib/db";
import { activePayoutDriverKey, getPayoutDriver } from "./adapters/registry";
export { activePayoutDriverKey } from "./adapters/registry";
import {
  configuredPayoutFee,
  declaredCapabilities,
  fromPesewas,
  isDefinitiveRejection,
  maskAccount,
  toPesewas,
  type PayoutDriver,
  type PayoutRail,
  type PayoutState,
} from "./adapters/payout";

/**
 * Merchant wallet service.
 *
 * Balances come only from the append-only ledger (migrations 0216, 0217), whose
 * invariants PostgreSQL checks at commit. This module decides what a merchant is
 * owed and sends payout commands; the connected provider holds and moves money.
 *
 * Payout safety rules (see docs/merchant-wallet.md):
 *  - Every send is recorded (wallet_payout_attempts, status "submitting") BEFORE
 *    the provider is called, so a crash leaves evidence that money may have moved.
 *  - A timeout or unknown error is "uncertain", never "failed". An uncertain
 *    payout is read back first. It is re-sent only when the provider guarantees
 *    idempotent initiation; otherwise it is quarantined for a human.
 *  - Funds return to "available" only when the provider reports the transfer
 *    failed or refused it outright.
 *  - Terminal states are final. A contradicting provider report is booked and
 *    raised as a reconciliation exception, never ignored.
 */

export type WalletBalances = {
  currency: "GHS";
  totalSales: string;
  refunded: string;
  pending: string;
  onHold: string;
  withheld: string;
  available: string;
  reserved: string;
  processing: string;
  paidOut: string;
  payoutFees: string;
  failedWithdrawals: string;
  owedFromRefunds: string;
};

/** Canonical, provider-independent withdrawal states shown to merchants. */
export const MERCHANT_PAYOUT_STATUS: Record<string, string> = {
  requested: "reserved",
  submitting: "processing",
  processing: "processing",
  uncertain: "under_review",
  needs_attention: "under_review",
  paid: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

const MAX_DISPATCH_ATTEMPTS = 8;
const LEASE = "interval '2 minutes'";
const money = (v: unknown) => fromPesewas(Math.max(0, Math.round(Number(v ?? 0) * 100)));
const signedMoney = (v: unknown) => {
  const n = Math.round(Number(v ?? 0) * 100);
  return `${n < 0 ? "-" : ""}${fromPesewas(Math.abs(n))}`;
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Withdrawal limits from deployment configuration, enforced inside PostgreSQL. */
export function withdrawalLimits(env: Record<string, string | undefined> = process.env) {
  const num = (key: string, fallback: number, max: number) => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  return {
    minAmount: num("ELEMARKET_WALLET_MIN_WITHDRAWAL", 5, 1_000_000),
    maxAmount: num("ELEMARKET_WALLET_MAX_WITHDRAWAL", 50_000, 1_000_000),
    dailyAmount: num("ELEMARKET_WALLET_DAILY_WITHDRAWAL_AMOUNT", 100_000, 10_000_000),
    dailyCount: Math.floor(num("ELEMARKET_WALLET_DAILY_WITHDRAWAL_COUNT", 5, 1000)),
    destinationCooldownHours: Math.floor(num("ELEMARKET_WALLET_DESTINATION_COOLDOWN_HOURS", 24, 24 * 30)),
  };
}

export async function getWalletSnapshot(merchantId: string) {
  const sql = await getSql();
  const [merchant] = await sql.query<{ settlement_model: string }>(
    `select settlement_model from merchants where id=$1`, [merchantId]);
  if (!merchant) throw new Error("Merchant not found");
  const [b] = await sql.query<Record<string, string>>(
    `select total_sales::text, refunded::text, withheld::text, available::text, processing::text,
            paid_out::text, payout_fees::text, recovery_due::text
       from merchant_wallet_balances where merchant_id=$1`, [merchantId]);
  const [split] = await sql.query<{ pending: string; on_hold: string; reserved: string; in_flight: string; failed: string }>(
    `select coalesce(sum(w.amount) filter (where elemarket_order_delivered_at(w.order_id) is null),0)::text as pending,
            coalesce(sum(w.amount) filter (where elemarket_order_delivered_at(w.order_id) is not null),0)::text as on_hold,
            (select coalesce(sum(amount),0) from wallet_payouts where merchant_id=$1 and status='requested')::text as reserved,
            (select coalesce(sum(amount),0) from wallet_payouts where merchant_id=$1
               and status in ('submitting','processing','uncertain','needs_attention'))::text as in_flight,
            (select coalesce(sum(amount),0) from wallet_payouts where merchant_id=$1 and status='failed')::text as failed
       from (select order_id, sum(amount) as amount from wallet_ledger_entries
              where merchant_id=$1 and bucket='withheld' and order_id is not null group by order_id having sum(amount)>0) w`,
    [merchantId]);
  const balances: WalletBalances = {
    currency: "GHS",
    totalSales: money(b?.total_sales),
    refunded: money(b?.refunded),
    pending: money(split?.pending),
    onHold: money(split?.on_hold),
    withheld: money(b?.withheld),
    available: money(b?.available),
    reserved: money(split?.reserved),
    processing: money(split?.in_flight),
    paidOut: money(b?.paid_out),
    payoutFees: money(b?.payout_fees),
    failedWithdrawals: money(split?.failed),
    owedFromRefunds: money(b?.recovery_due),
  };
  const withheldOrders = await sql.query<{ order_id: string; amount: string; status: string; releases_at: string | null; hold_reason: string | null }>(
    `select o.id as order_id, sum(e.amount)::text as amount, o.status,
            case when elemarket_order_delivered_at(o.id) is null then null
                 else elemarket_order_release_at(o.id)::text
            end as releases_at,
            case when exists(select 1 from customer_order_disputes d where d.order_id=o.id and d.status in ('open','under_review')) then 'Open dispute'
                 when exists(select 1 from return_requests r where r.order_id=o.id and r.status in ('requested','approved','received','refund_pending')) then 'Return in progress'
                 when exists(select 1 from provider_refund_requests pr where pr.order_id=o.id and pr.status in ('requested','processing','needs_attention')) then 'Refund in progress'
                 when elemarket_order_delivered_at(o.id) is null then 'Awaiting delivery confirmation'
                 else 'Return window open' end as hold_reason
       from wallet_ledger_entries e join orders o on o.id=e.order_id
      where e.merchant_id=$1 and e.bucket='withheld'
      group by o.id, o.status
     having sum(e.amount) > 0
      order by min(e.created_at) desc limit 50`, [merchantId]);
  const ledger = await sql.query<{ id: string; entry_type: string; bucket: string; amount: string; order_id: string | null; payout_id: string | null; created_at: string }>(
    `select id::text, entry_type, bucket, amount::text, order_id, payout_id, created_at::text
       from wallet_ledger_entries where merchant_id=$1 order by id desc limit 100`, [merchantId]);
  const payouts = await sql.query<{ id: string; amount: string; fee: string; net_amount: string; status: string; display_hint: string | null; rail: string; failure_reason: string | null; created_at: string; completed_at: string | null; cancellable: boolean }>(
    `select w.id, w.amount::text, w.fee::text, w.net_amount::text, w.status, a.display_hint, w.rail, w.failure_reason,
            w.created_at::text, w.completed_at::text,
            (w.status='requested' and (w.lease_until is null or w.lease_until < now())
              and not exists(select 1 from wallet_payout_attempts t where t.payout_id=w.id and t.kind='send')) as cancellable
       from wallet_payouts w join merchant_payout_accounts a on a.id=w.destination_id
      where w.merchant_id=$1 order by w.created_at desc limit 25`, [merchantId]);
  const limits = withdrawalLimits();
  const destinations = await sql.query<{ id: string; rail: string; display_hint: string | null; account_name: string | null; status: string; driver_key: string | null; usable_from: string }>(
    `select id, rail, display_hint, account_name, status, driver_key,
            (coalesce(verified_at, created_at) + make_interval(hours => $2::int))::text as usable_from
       from merchant_payout_accounts
      where merchant_id=$1 and status <> 'disabled' and driver_key is not null order by created_at desc`,
    [merchantId, limits.destinationCooldownHours]);
  let payoutsConfigured = true;
  try { activePayoutDriverKey(); } catch { payoutsConfigured = false; }
  return {
    merchantId,
    walletEnabled: merchant.settlement_model === "platform_wallet",
    payoutsConfigured,
    limits: { minAmount: limits.minAmount.toFixed(2), maxAmount: limits.maxAmount.toFixed(2), dailyCount: limits.dailyCount },
    balances,
    withheldOrders: withheldOrders.map((r) => ({ orderId: r.order_id, amount: money(r.amount), status: r.status, releasesAt: r.releases_at, holdReason: r.hold_reason })),
    ledger: ledger.map((r) => ({ id: r.id, type: r.entry_type, bucket: r.bucket, amount: signedMoney(r.amount), orderId: r.order_id, payoutId: r.payout_id, createdAt: r.created_at })),
    payouts: payouts.map((r) => ({
      id: r.id, amount: r.amount, fee: r.fee, netAmount: r.net_amount, status: MERCHANT_PAYOUT_STATUS[r.status] ?? "under_review",
      destination: r.display_hint, rail: r.rail, failureReason: r.status === "failed" ? r.failure_reason : null,
      createdAt: r.created_at, completedAt: r.completed_at, cancellable: r.cancellable,
    })),
    destinations: destinations.map((r) => ({ id: r.id, rail: r.rail, displayHint: r.display_hint, accountName: r.account_name, status: r.status, driverKey: r.driver_key, usableFrom: r.usable_from })),
  };
}

export async function registerPayoutDestination(input: {
  merchantId: string;
  rail: PayoutRail;
  accountNumber: string;
  institutionCode: string;
  accountName: string;
  actorUserId?: string;
}) {
  const driverKey = activePayoutDriverKey();
  const driver = await getPayoutDriver(driverKey);
  const registered = await driver.registerDestination({
    rail: input.rail,
    accountNumber: input.accountNumber,
    institutionCode: input.institutionCode,
    accountName: input.accountName,
  });
  // A destination is verified only when the provider can and did confirm it.
  const verified = declaredCapabilities(driver).destinationValidation && registered.verified === true;
  const sql = await getSql();
  const id = `mpa_${crypto.randomUUID().replaceAll("-", "")}`;
  const rows = await sql.query<{ id: string; status: string }>(
    `insert into merchant_payout_accounts(id, merchant_id, rail, destination_ref, status, driver_key, display_hint, account_name, verified_at)
     values($1,$2,$3,$4,$5,$6,$7,$8, case when $5='verified' then now() end)
     on conflict (merchant_id, rail, destination_ref) do update set updated_at=now()
     returning id, status`,
    [id, input.merchantId, input.rail, registered.destinationRef, verified ? "verified" : "pending",
      driverKey, maskAccount(input.accountNumber), registered.resolvedAccountName ?? input.accountName.trim()],
  );
  await sql.query(`select record_audit_event('merchant.wallet.destination_added','payout_destination',$1,$2,'merchant',null,'success',$3::jsonb)`,
    [rows[0].id, input.actorUserId ?? null, JSON.stringify({ merchantId: input.merchantId, rail: input.rail, hint: maskAccount(input.accountNumber), status: rows[0].status })]);
  return { destinationId: rows[0].id, status: rows[0].status, accountName: registered.resolvedAccountName };
}

export async function quoteWithdrawal(input: { merchantId: string; amount: string; destinationId: string }) {
  const sql = await getSql();
  const [dest] = await sql.query<{ rail: PayoutRail; driver_key: string | null }>(
    `select rail, driver_key from merchant_payout_accounts where id=$1 and merchant_id=$2 and status='verified'`,
    [input.destinationId, input.merchantId]);
  if (!dest) throw new Error("Payout destination is not verified");
  const driverKey = activePayoutDriverKey();
  if (dest.driver_key && dest.driver_key !== driverKey)
    throw new Error("This payout destination belongs to a previous payout provider; add it again");
  const driver = await getPayoutDriver(driverKey);
  const amount = fromPesewas(toPesewas(input.amount));
  const quoted = declaredCapabilities(driver).feeQuote
    ? await driver.quoteFee({ amount, currency: "GHS", rail: dest.rail })
    : configuredPayoutFee(amount);
  const fee = fromPesewas(toPesewas(quoted));
  if (toPesewas(fee) >= toPesewas(amount)) throw new Error("Amount must be larger than the transfer fee");
  return { amount, fee, netAmount: fromPesewas(toPesewas(amount) - toPesewas(fee)), driverKey };
}

export async function requestWithdrawal(input: {
  merchantId: string;
  userId: string;
  amount: string;
  destinationId: string;
  idempotencyKey: string;
}) {
  const sql = await getSql();
  // A replayed request returns the original withdrawal before anything else runs.
  const [existing] = await sql.query<{ id: string; status: string; amount: string; fee: string; net_amount: string; destination_id: string; driver_key: string }>(
    `select id, status, amount::text, fee::text, net_amount::text, destination_id, driver_key from wallet_payouts
      where merchant_id=$1 and idempotency_key=$2`, [input.merchantId, input.idempotencyKey]);
  if (existing) {
    if (toPesewas(existing.amount) !== toPesewas(input.amount) || existing.destination_id !== input.destinationId)
      throw new Error("idempotency conflict");
    return { payoutId: existing.id, status: existing.status, amount: existing.amount, fee: existing.fee, netAmount: existing.net_amount, driverKey: existing.driver_key, replay: true };
  }
  const quote = await quoteWithdrawal(input);
  const [row] = await sql.query<{ result: { payoutId: string; status: string; replay: boolean } }>(
    `select wallet_request_payout($1,$2::numeric,$3::numeric,$4,$5,$6,$7,$8::jsonb) as result`,
    [input.merchantId, quote.amount, quote.fee, input.destinationId, quote.driverKey, input.idempotencyKey, input.userId,
      JSON.stringify(withdrawalLimits())],
  );
  const result = row.result;
  // Send the command straight away; the scheduled job recovers if this fails.
  if (!result.replay) await dispatchPayouts({ payoutId: result.payoutId }).catch(() => undefined);
  const [current] = await sql.query<{ status: string }>(`select status from wallet_payouts where id=$1`, [result.payoutId]);
  return { ...quote, payoutId: result.payoutId, status: current?.status ?? result.status, replay: result.replay };
}

export async function cancelWithdrawal(input: { merchantId: string; payoutId: string; userId: string }) {
  const sql = await getSql();
  const [row] = await sql.query<{ result: { payoutId: string; status: string } }>(
    `select wallet_cancel_payout($1,$2,$3) as result`, [input.payoutId, input.merchantId, input.userId]);
  return row.result;
}

type ClaimedPayout = {
  id: string; merchant_id: string; status: string; amount: string; fee: string; net_amount: string; driver_key: string;
  provider_reference: string | null; dispatch_attempts: number; lease_token: string; destination_ref: string; rail: PayoutRail;
};

/** Apply a provider-reported state through the single settlement function. */
async function applyProviderState(payoutId: string, state: PayoutState, source: string) {
  const sql = await getSql();
  const outcome = state.status === "processing" ? "accepted" : state.status;
  if (state.currency && state.currency !== "GHS") {
    const [r] = await sql.query<{ result: { status: string } }>(
      `select wallet_settle_payout($1,'needs_attention',$2,$3,null,$4) as result`,
      [payoutId, state.providerReference, `Provider reported currency ${state.currency}`, source]);
    return r.result.status;
  }
  const [r] = await sql.query<{ result: { status: string } }>(
    `select wallet_settle_payout($1,$2,$3,$4,$5::numeric,$6) as result`,
    [payoutId, outcome, state.providerReference || null, state.failureReason ?? null, state.amount ?? null, source]);
  return r.result.status;
}

async function quarantine(payoutId: string, reason: string, source: string) {
  const sql = await getSql();
  await sql.query(`select wallet_settle_payout($1,'needs_attention',null,$2,null,$3)`, [payoutId, reason, source]);
  return "needs_attention";
}

/** Send once. The attempt is durable before the provider is called. */
async function send(payout: ClaimedPayout, driver: PayoutDriver): Promise<string> {
  const sql = await getSql();
  const [{ result: begun }] = await sql.query<{ result: { ok: boolean; attemptNo?: number } }>(
    `select wallet_begin_send($1,$2) as result`, [payout.id, payout.lease_token]);
  if (!begun.ok) return "lease_lost";
  const attemptNo = begun.attemptNo!;
  let state: PayoutState;
  try {
    state = await driver.createPayout({
      payoutId: payout.id,
      idempotencyKey: payout.id,
      amount: payout.net_amount,
      currency: "GHS",
      rail: payout.rail,
      destinationRef: payout.destination_ref, // the destination authorized at request time
      narration: `ELEMARKET payout ${payout.id.slice(4, 16)}`,
    });
  } catch (error) {
    if (isDefinitiveRejection(error)) {
      await sql.query(`select wallet_record_attempt($1,$2,'send','rejected',null,$3)`, [payout.id, attemptNo, errorText(error)]);
      // The provider refused it outright: non-payment is established.
      const [r] = await sql.query<{ result: { status: string } }>(
        `select wallet_settle_payout($1,'failed',null,$2,null,'send') as result`, [payout.id, errorText(error)]);
      return r.result.status;
    }
    // Timeout or unknown error: the transfer may exist. Never a failure.
    await sql.query(`select wallet_record_attempt($1,$2,'send','uncertain',null,$3)`, [payout.id, attemptNo, errorText(error)]);
    await sql.query(`select wallet_mark_uncertain($1,$2,$3,$4)`,
      [payout.id, payout.lease_token, `Provider outcome unknown: ${errorText(error)}`, 30 * 2 ** Math.min(payout.dispatch_attempts, 6)]);
    return "uncertain";
  }
  await sql.query(`select wallet_record_attempt($1,$2,'send',$3,$4,null)`,
    [payout.id, attemptNo, state.status === "processing" ? "accepted" : state.status, state.providerReference]);
  return applyProviderState(payout.id, state, "send");
}

/** An uncertain (or crashed mid-send) payout: read back, never blind-retry. */
async function recover(payout: ClaimedPayout, driver: PayoutDriver): Promise<string> {
  const sql = await getSql();
  const caps = declaredCapabilities(driver);
  // A worker that stopped mid-send left "submitting": that is uncertain, not failed.
  await sql.query(`update wallet_payouts set status='uncertain', updated_at=now()
                    where id=$1 and status='submitting' and lease_token=$2`, [payout.id, payout.lease_token]);
  // A send left "pending" by a crashed worker is uncertain, not failed.
  await sql.query(`update wallet_payout_attempts set outcome='uncertain', finished_at=now(),
                     detail=coalesce(detail,'Worker stopped before the provider response was recorded')
                    where payout_id=$1 and kind='send' and outcome='pending'`, [payout.id]);
  const [{ sends }] = await sql.query<{ sends: number }>(
    `select count(*)::int as sends from wallet_payout_attempts where payout_id=$1 and kind='send'`, [payout.id]);
  if (!caps.statusLookup || typeof driver.getPayout !== "function")
    return quarantine(payout.id, "Outcome unknown and this provider cannot report payout status; check with the provider before any action", "recovery");
  let state: PayoutState | null;
  try {
    state = await driver.getPayout(payout.id, payout.provider_reference);
  } catch (error) {
    await sql.query(`select wallet_record_attempt($1,null,'lookup','error',null,$2)`, [payout.id, errorText(error)]);
    if (payout.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS)
      return quarantine(payout.id, "Provider status could not be read after repeated attempts", "recovery");
    await sql.query(`select wallet_mark_uncertain($1,$2,$3,$4)`,
      [payout.id, payout.lease_token, `Status lookup failed: ${errorText(error)}`, 30 * 2 ** Math.min(payout.dispatch_attempts, 6)]);
    return "uncertain";
  }
  if (state) {
    await sql.query(`select wallet_record_attempt($1,null,'lookup',$2,$3,null)`,
      [payout.id, state.status === "processing" ? "accepted" : state.status, state.providerReference]);
    return applyProviderState(payout.id, state, "lookup");
  }
  await sql.query(`select wallet_record_attempt($1,null,'lookup','not_found',null,null)`, [payout.id]);
  if (sends === 0) return send(payout, driver);
  // The provider has no record of a send whose outcome we did not see.
  if (caps.idempotentInitiation && sends < MAX_DISPATCH_ATTEMPTS) return send(payout, driver);
  return quarantine(payout.id, caps.idempotentInitiation
    ? "Provider still has no record after repeated sends"
    : "Provider has no record of a send whose outcome was lost, and cannot de-duplicate a repeated send", "recovery");
}

/**
 * Claim and process payouts. Workers on any number of instances coordinate
 * through PostgreSQL (row locks + leases), never through memory.
 */
export async function dispatchPayouts(options: { limit?: number; payoutId?: string } = {}) {
  const sql = await getSql();
  const token = crypto.randomUUID();
  const claimed = await sql.query<ClaimedPayout>(
    `with picked as (
       select id from wallet_payouts
        where ((status='requested' and next_attempt_at <= now())
            or (status in ('uncertain','submitting') and next_attempt_at <= now()))
          and (lease_until is null or lease_until < now())
          and ($2::text is null or id=$2)
        order by created_at limit $3 for update skip locked)
     update wallet_payouts w set lease_token=$1, lease_until=now()+${LEASE},
            dispatch_attempts=dispatch_attempts+1, updated_at=now()
       from picked where w.id=picked.id
     returning w.id, w.merchant_id, w.status, w.amount::text, w.fee::text, w.net_amount::text, w.driver_key,
               w.provider_reference, w.dispatch_attempts, w.lease_token, w.destination_ref, w.rail`,
    [token, options.payoutId ?? null, Math.max(1, Math.min(options.limit ?? 25, 100))],
  );
  const outcomes: Record<string, string> = {};
  for (const payout of claimed) {
    try {
      const driver = await getPayoutDriver(payout.driver_key);
      outcomes[payout.id] = payout.status === "requested" ? await send(payout, driver) : await recover(payout, driver);
    } catch (error) {
      // Our own failure (database, configuration). Whatever happened, the next
      // run reads the provider back before anything else; persistent failure escalates.
      outcomes[payout.id] = `error: ${errorText(error)}`;
      if (payout.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS)
        await quarantine(payout.id, `Payout could not be processed: ${errorText(error)}`, "dispatch").catch(() => undefined);
      else
        await sql.query(`select wallet_mark_uncertain($1,$2,$3,$4)`,
          [payout.id, payout.lease_token, `Dispatch error: ${errorText(error)}`, 60]).catch(() => undefined);
    }
  }
  return outcomes;
}

/** Read back payouts the provider accepted but has not finished. */
export async function reconcilePayouts(limit = 50) {
  const sql = await getSql();
  const rows = await sql.query<{ id: string; driver_key: string; provider_reference: string | null; updated_at: string }>(
    `select id, driver_key, provider_reference, updated_at::text from wallet_payouts
      where status='processing' and updated_at < now() - interval '1 minute'
      order by updated_at limit $1`, [Math.max(1, Math.min(limit, 200))]);
  const outcomes: Record<string, string> = {};
  for (const payout of rows) {
    try {
      const driver = await getPayoutDriver(payout.driver_key);
      if (!declaredCapabilities(driver).statusLookup || !driver.getPayout) {
        // Webhook-only provider: wait for an authenticated notification, then escalate.
        if (Date.now() - new Date(payout.updated_at).getTime() > 24 * 3600e3)
          outcomes[payout.id] = await quarantine(payout.id, "No final status from the provider within 24 hours", "reconcile");
        else outcomes[payout.id] = "awaiting_webhook";
        continue;
      }
      const state = await driver.getPayout(payout.id, payout.provider_reference);
      if (!state) {
        await sql.query(`select wallet_record_exception('missing_at_provider','high',$1,$2,$3,$4::jsonb)`,
          [`missing:${payout.id}`, payout.id, payout.driver_key, JSON.stringify({ providerReference: payout.provider_reference })]);
        outcomes[payout.id] = await quarantine(payout.id, "Provider has no record of an accepted payout", "reconcile");
      } else {
        outcomes[payout.id] = await applyProviderState(payout.id, state, "reconcile");
        if (outcomes[payout.id] === "processing")
          await sql.query(`update wallet_payouts set updated_at=now() where id=$1 and status='processing'`, [payout.id]);
      }
    } catch {
      outcomes[payout.id] = "retry";
    }
  }
  return outcomes;
}

/** Re-check recently settled payouts so a provider reversal or late success is never missed. */
export async function verifySettledPayouts(limit = 50) {
  const sql = await getSql();
  const rows = await sql.query<{ id: string; driver_key: string; provider_reference: string | null; status: string }>(
    `select id, driver_key, provider_reference, status from wallet_payouts
      where status in ('paid','failed') and completed_at > now() - interval '7 days'
        and updated_at < now() - interval '1 minute'
      order by updated_at limit $1`, [Math.max(1, Math.min(limit, 200))]);
  const outcomes: Record<string, string> = {};
  for (const payout of rows) {
    try {
      const driver = await getPayoutDriver(payout.driver_key);
      if (!declaredCapabilities(driver).statusLookup || !driver.getPayout) continue;
      const state = await driver.getPayout(payout.id, payout.provider_reference);
      if (state && state.status !== "processing" && state.status !== payout.status)
        outcomes[payout.id] = await applyProviderState(payout.id, state, "verification");
      await sql.query(`update wallet_payouts set updated_at=now() where id=$1`, [payout.id]);
    } catch { /* next run */ }
  }
  return outcomes;
}

/** Compare the provider's own transfer list with the wallet. Raises exceptions; never edits balances silently. */
export async function reconcileProviderRecords(sinceHours = 7 * 24) {
  const sql = await getSql();
  const keys = await sql.query<{ driver_key: string }>(
    `select distinct driver_key from wallet_payouts where created_at > now() - make_interval(hours => $1::int)`, [sinceHours]);
  const report: Record<string, { checked: number; exceptions: number } | string> = {};
  for (const { driver_key: key } of keys) {
    try {
      const driver = await getPayoutDriver(key);
      if (!declaredCapabilities(driver).reconciliationListing || !driver.listPayouts) { report[key] = "listing not supported"; continue; }
      const records = await driver.listPayouts(new Date(Date.now() - sinceHours * 3600e3));
      let exceptions = 0;
      const byPayout = new Map<string, typeof records>();
      for (const r of records) {
        if (!r.payoutId) {
          exceptions++;
          await sql.query(`select wallet_record_exception('unknown_external_payout','critical',$1,null,$2,$3::jsonb)`,
            [`unknown:${key}:${r.providerReference}`, key, JSON.stringify(r)]);
          continue;
        }
        byPayout.set(r.payoutId, [...(byPayout.get(r.payoutId) ?? []), r]);
      }
      const ids = [...byPayout.keys()];
      const ours = ids.length ? await sql.query<{ id: string; status: string; net_amount: string; provider_reference: string | null }>(
        `select id, status, net_amount::text, provider_reference from wallet_payouts where id = any($1::text[]) and driver_key=$2`, [ids, key]) : [];
      const known = new Map(ours.map((o) => [o.id, o]));
      for (const [payoutId, recs] of byPayout) {
        const mine = known.get(payoutId);
        if (!mine) {
          exceptions++;
          await sql.query(`select wallet_record_exception('unknown_external_payout','critical',$1,null,$2,$3::jsonb)`,
            [`unknown:${key}:${payoutId}`, key, JSON.stringify({ payoutId, records: recs })]);
          continue;
        }
        const live = recs.filter((r) => r.status !== "failed");
        if (live.length > 1) {
          exceptions++;
          await sql.query(`select wallet_record_exception('duplicate_external_payout','critical',$1,$2,$3,$4::jsonb)`,
            [`dup:${payoutId}`, payoutId, key, JSON.stringify({ transfers: live.map((r) => ({ ref: r.providerReference, status: r.status, amount: r.amount })) })]);
        }
        for (const r of live) {
          if (toPesewas(r.amount) !== toPesewas(mine.net_amount)) {
            exceptions++;
            await sql.query(`select wallet_record_exception('amount_mismatch','critical',$1,$2,$3,$4::jsonb)`,
              [`listing-amount:${payoutId}:${r.providerReference}`, payoutId, key, JSON.stringify({ expectedNet: mine.net_amount, reported: r.amount })]);
          }
        }
        const paid = recs.find((r) => r.status === "paid");
        if (paid && mine.status !== "paid") await applyProviderState(payoutId, paid, "listing");
      }
      report[key] = { checked: records.length, exceptions };
    } catch (error) {
      report[key] = `error: ${errorText(error)}`;
    }
  }
  return report;
}

export class PayoutWebhookError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Provider notification. Authenticated by the driver, stored once in the
 * inbox, then applied: re-read from the provider when it supports lookups,
 * otherwise the authenticated notification is the provider's statement.
 */
export async function handlePayoutWebhook(input: { rawBody: string; headers: Headers }) {
  if (input.rawBody.length > 64 * 1024) throw new PayoutWebhookError("Payload too large", 413);
  const sql = await getSql();
  const keys = await sql.query<{ driver_key: string }>(
    `select distinct driver_key from wallet_payouts where created_at > now() - interval '30 days'`);
  const candidates = new Set(keys.map((k) => k.driver_key));
  try { candidates.add(activePayoutDriverKey()); } catch { /* payouts not configured */ }
  const verified: PayoutDriver[] = [];
  for (const key of candidates) {
    try {
      const driver = await getPayoutDriver(key);
      if (!declaredCapabilities(driver).webhooks || !driver.verifyWebhook || !driver.parseWebhook) continue;
      const signature = driver.webhookSignatureHeaders?.map((h) => input.headers.get(h)).find(Boolean) ?? null;
      if (await driver.verifyWebhook(input.rawBody, signature)) verified.push(driver);
    } catch { /* a misconfigured driver must not block others */ }
  }
  if (verified.length !== 1) throw new PayoutWebhookError("Invalid webhook signature", 401);
  const driver = verified[0];
  const notice = await driver.parseWebhook!(input.rawBody).catch(() => null);
  if (!notice || !/^wpo_[a-f0-9]{32}$/.test(notice.payoutId)) throw new PayoutWebhookError("Invalid webhook payload", 400);
  const digest = createHash("sha256").update(input.rawBody).digest("hex");
  const inserted = await sql.query<{ id: string }>(
    `insert into wallet_payout_events(driver_key, payload_sha256, payout_id, reported_status) values($1,$2,$3,$4)
     on conflict (driver_key, payload_sha256) do nothing returning id::text`,
    [driver.key, digest, notice.payoutId, notice.status ?? null]);
  const [payout] = await sql.query<{ id: string; driver_key: string; provider_reference: string | null; status: string }>(
    `select id, driver_key, provider_reference, status from wallet_payouts where id=$1`, [notice.payoutId]);
  if (!payout || payout.driver_key !== driver.key) throw new PayoutWebhookError("Unknown payout", 404);
  if (!inserted[0]) return { payoutId: payout.id, status: payout.status, duplicate: true };
  let state: PayoutState | null = null;
  if (declaredCapabilities(driver).statusLookup && driver.getPayout) {
    state = await driver.getPayout(payout.id, payout.provider_reference ?? notice.providerReference);
  } else if (notice.status && notice.providerReference) {
    state = { providerReference: notice.providerReference, status: notice.status, amount: notice.amount };
  }
  const status = state ? await applyProviderState(payout.id, state, "webhook") : payout.status;
  await sql.query(`update wallet_payout_events set processed_at=now(), outcome=$3 where driver_key=$1 and payload_sha256=$2`,
    [driver.key, digest, status]);
  return { payoutId: payout.id, status };
}

export async function runWalletSettlement() {
  const sql = await getSql();
  const [released] = await sql.query<{ count: number }>(`select release_matured_wallet_funds(200) as count`);
  const dispatched = await dispatchPayouts({ limit: 25 });
  const reconciled = await reconcilePayouts(50);
  const verified = await verifySettledPayouts(25);
  return { released: Number(released?.count ?? 0), dispatched, reconciled, verified };
}

export async function runWalletReconciliation() {
  const sql = await getSql();
  const providers = await reconcileProviderRecords();
  const [row] = await sql.query<{ summary: Record<string, unknown> }>(`select wallet_reconciliation_summary() as summary`);
  return { providers, summary: row.summary };
}

export async function enableWalletForMerchant(merchantId: string, adminId: string) {
  const sql = await getSql();
  const [row] = await sql.query<{ result: { merchantId: string; settlementModel: string; changed: boolean } }>(
    `select wallet_enable_for_merchant($1,$2) as result`, [merchantId, adminId]);
  return row.result;
}

export async function resolvePayoutByAdmin(input: { payoutId: string; outcome: "paid" | "failed" | "requeue"; adminId: string; evidence: string; providerReference?: string }) {
  const sql = await getSql();
  const [row] = await sql.query<{ result: { payoutId: string; status: string } }>(
    `select wallet_admin_resolve_payout($1,$2,$3,$4,$5) as result`,
    [input.payoutId, input.outcome, input.adminId, input.evidence, input.providerReference ?? null]);
  return row.result;
}

export async function listWalletExceptions(status: "open" | "resolved" = "open") {
  const sql = await getSql();
  return sql.query<{ id: string; kind: string; severity: string; payout_id: string | null; merchant_id: string | null; details: unknown; created_at: string }>(
    `select id::text, kind, severity, payout_id, merchant_id, details, created_at::text from wallet_reconciliation_exceptions
      where status=$1 order by created_at desc limit 200`, [status]);
}

export async function resolveWalletException(input: { exceptionId: string; adminId: string; resolution: string }) {
  const sql = await getSql();
  await sql.query(`select wallet_resolve_exception($1::bigint,$2,$3)`, [input.exceptionId, input.adminId, input.resolution]);
  return { ok: true };
}
