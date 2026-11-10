import { getSql } from "@/lib/db";
import { activePayoutDriverKey, getPayoutDriver } from "./adapters/registry";
export { activePayoutDriverKey } from "./adapters/registry";
import {
  fromPesewas,
  maskAccount,
  PayoutProviderError,
  toPesewas,
  type PayoutDriver,
  type PayoutRail,
  type PayoutState,
} from "./adapters/payout";

/**
 * Merchant wallet service. Balances come only from the append-only ledger
 * (migration 0216). This module decides what is owed and sends payout commands;
 * the configured provider holds and moves the money.
 */

export type WalletBalances = {
  currency: "GHS";
  totalSales: string;
  refunded: string;
  withheld: string;
  available: string;
  processing: string;
  paidOut: string;
  payoutFees: string;
};

const MAX_DISPATCH_ATTEMPTS = 8;
const money = (v: unknown) => fromPesewas(Math.max(0, Math.round(Number(v ?? 0) * 100)));
const signedMoney = (v: unknown) => {
  const n = Math.round(Number(v ?? 0) * 100);
  return `${n < 0 ? "-" : ""}${fromPesewas(Math.abs(n))}`;
};

export async function getWalletSnapshot(merchantId: string) {
  const sql = await getSql();
  const [merchant] = await sql.query<{ settlement_model: string }>(
    `select settlement_model from merchants where id=$1`, [merchantId]);
  if (!merchant) throw new Error("Merchant not found");
  const [b] = await sql.query<Record<string, string>>(
    `select total_sales::text, refunded::text, withheld::text, available::text, processing::text,
            paid_out::text, payout_fees::text
       from merchant_wallet_balances where merchant_id=$1`, [merchantId]);
  const balances: WalletBalances = {
    currency: "GHS",
    totalSales: money(b?.total_sales),
    refunded: money(b?.refunded),
    withheld: money(b?.withheld),
    // Available can be negative after a late refund; show the real figure.
    available: signedMoney(b?.available),
    processing: money(b?.processing),
    paidOut: money(b?.paid_out),
    payoutFees: money(b?.payout_fees),
  };
  const withheldOrders = await sql.query<{ order_id: string; amount: string; status: string; releases_at: string | null; hold_reason: string | null }>(
    `select o.id as order_id, sum(e.amount)::text as amount, o.status,
            case when elemarket_order_delivered_at(o.id) is null then null
                 else (elemarket_order_delivered_at(o.id) + greatest(interval '24 hours', make_interval(days => coalesce(
                   (select max(p.return_window_days) from order_items oi join products p on p.id=oi.product_id where oi.order_id=o.id),0))))::text
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
  const payouts = await sql.query<{ id: string; amount: string; fee: string; net_amount: string; status: string; display_hint: string | null; rail: string; failure_reason: string | null; created_at: string; completed_at: string | null }>(
    `select w.id, w.amount::text, w.fee::text, w.net_amount::text, w.status, a.display_hint, a.rail, w.failure_reason,
            w.created_at::text, w.completed_at::text
       from wallet_payouts w join merchant_payout_accounts a on a.id=w.destination_id
      where w.merchant_id=$1 order by w.created_at desc limit 25`, [merchantId]);
  const destinations = await sql.query<{ id: string; rail: string; display_hint: string | null; account_name: string | null; status: string; driver_key: string | null }>(
    `select id, rail, display_hint, account_name, status, driver_key from merchant_payout_accounts
      where merchant_id=$1 and status <> 'disabled' and driver_key is not null order by created_at desc`, [merchantId]);
  let payoutsConfigured = true;
  try { activePayoutDriverKey(); } catch { payoutsConfigured = false; }
  return {
    merchantId,
    walletEnabled: merchant.settlement_model === "platform_wallet",
    payoutsConfigured,
    balances,
    withheldOrders: withheldOrders.map((r) => ({ orderId: r.order_id, amount: money(r.amount), status: r.status, releasesAt: r.releases_at, holdReason: r.hold_reason })),
    ledger: ledger.map((r) => ({ id: r.id, type: r.entry_type, bucket: r.bucket, amount: signedMoney(r.amount), orderId: r.order_id, payoutId: r.payout_id, createdAt: r.created_at })),
    payouts: payouts.map((r) => ({ id: r.id, amount: r.amount, fee: r.fee, netAmount: r.net_amount, status: r.status, destination: r.display_hint, rail: r.rail, failureReason: r.failure_reason, createdAt: r.created_at, completedAt: r.completed_at })),
    destinations: destinations.map((r) => ({ id: r.id, rail: r.rail, displayHint: r.display_hint, accountName: r.account_name, status: r.status, driverKey: r.driver_key })),
  };
}

export async function registerPayoutDestination(input: {
  merchantId: string;
  rail: PayoutRail;
  accountNumber: string;
  institutionCode: string;
  accountName: string;
}) {
  const driverKey = activePayoutDriverKey();
  const driver = await getPayoutDriver(driverKey);
  const registered = await driver.registerDestination({
    rail: input.rail,
    accountNumber: input.accountNumber,
    institutionCode: input.institutionCode,
    accountName: input.accountName,
  });
  const sql = await getSql();
  const id = `mpa_${crypto.randomUUID().replaceAll("-", "")}`;
  const rows = await sql.query<{ id: string; status: string }>(
    `insert into merchant_payout_accounts(id, merchant_id, rail, destination_ref, status, driver_key, display_hint, account_name, verified_at)
     values($1,$2,$3,$4,$5,$6,$7,$8, case when $5='verified' then now() end)
     on conflict (merchant_id, rail, destination_ref) do update set updated_at=now()
     returning id, status`,
    [id, input.merchantId, input.rail, registered.destinationRef, registered.verified ? "verified" : "pending",
      driverKey, maskAccount(input.accountNumber), registered.resolvedAccountName ?? input.accountName.trim()],
  );
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
  const fee = fromPesewas(toPesewas(await driver.quoteFee({ amount, currency: "GHS", rail: dest.rail })));
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
  const quote = await quoteWithdrawal(input);
  const sql = await getSql();
  const [row] = await sql.query<{ result: { payoutId: string; status: string; replay: boolean } }>(
    `select wallet_request_payout($1,$2::numeric,$3::numeric,$4,$5,$6,$7) as result`,
    [input.merchantId, quote.amount, quote.fee, input.destinationId, quote.driverKey, input.idempotencyKey, input.userId],
  );
  const result = row.result;
  // Send the command straight away; the scheduled job retries if this fails.
  if (!result.replay) await dispatchPayouts({ payoutId: result.payoutId }).catch(() => undefined);
  const [current] = await sql.query<{ status: string }>(`select status from wallet_payouts where id=$1`, [result.payoutId]);
  return { ...quote, payoutId: result.payoutId, status: current?.status ?? result.status };
}

type ClaimedPayout = {
  id: string; merchant_id: string; amount: string; fee: string; net_amount: string; driver_key: string;
  provider_reference: string | null; dispatch_attempts: number; lease_token: string; destination_ref: string; rail: PayoutRail;
};

async function settle(payout: { id: string; net_amount: string; provider_reference: string | null }, state: PayoutState) {
  const sql = await getSql();
  if (state.status === "processing") {
    await sql.query(
      `update wallet_payouts set status='processing', provider_reference=coalesce(provider_reference,$2),
              lease_token=null, lease_until=null, updated_at=now() where id=$1 and status in ('requested','processing')`,
      [payout.id, state.providerReference]);
    return "processing";
  }
  if (state.status === "paid" && state.amount && toPesewas(state.amount) !== toPesewas(payout.net_amount)) {
    await sql.query(`select wallet_settle_payout($1,'needs_attention',$2,$3)`,
      [payout.id, state.providerReference, `Provider reported ${state.amount} instead of ${payout.net_amount}`]);
    return "needs_attention";
  }
  if (state.currency && state.currency !== "GHS") {
    await sql.query(`select wallet_settle_payout($1,'needs_attention',$2,$3)`,
      [payout.id, state.providerReference, `Provider reported currency ${state.currency}`]);
    return "needs_attention";
  }
  await sql.query(`select wallet_settle_payout($1,$2,$3,$4)`,
    [payout.id, state.status, state.providerReference, state.failureReason ?? null]);
  return state.status;
}

/** Send requested payouts to their provider. Safe to run concurrently and repeatedly. */
export async function dispatchPayouts(options: { limit?: number; payoutId?: string } = {}) {
  const sql = await getSql();
  const token = crypto.randomUUID();
  const claimed = await sql.query<ClaimedPayout>(
    `with picked as (
       select id from wallet_payouts
        where status='requested' and next_attempt_at <= now()
          and (lease_until is null or lease_until < now())
          and ($2::text is null or id=$2)
        order by created_at limit $3 for update skip locked)
     update wallet_payouts w set lease_token=$1, lease_until=now()+interval '2 minutes',
            dispatch_attempts=dispatch_attempts+1, updated_at=now()
       from picked, merchant_payout_accounts a
      where w.id=picked.id and a.id=w.destination_id
     returning w.id, w.merchant_id, w.amount::text, w.fee::text, w.net_amount::text, w.driver_key,
               w.provider_reference, w.dispatch_attempts, w.lease_token, a.destination_ref, a.rail`,
    [token, options.payoutId ?? null, Math.max(1, Math.min(options.limit ?? 25, 100))],
  );
  const outcomes: Record<string, string> = {};
  for (const payout of claimed) {
    try {
      const driver: PayoutDriver = await getPayoutDriver(payout.driver_key);
      if (driver.supportsIdempotentPayouts !== true) throw new PayoutProviderError("Driver is not idempotent", true);
      // A retried dispatch first asks whether the provider already has it.
      const existing = payout.dispatch_attempts > 1 ? await driver.getPayout(payout.id, payout.provider_reference) : null;
      const state = existing ?? await driver.createPayout({
        payoutId: payout.id,
        idempotencyKey: payout.id,
        amount: payout.net_amount,
        currency: "GHS",
        rail: payout.rail,
        destinationRef: payout.destination_ref,
        narration: `ELEMARKET payout ${payout.id.slice(4, 16)}`,
      });
      outcomes[payout.id] = await settle(payout, state);
    } catch (error) {
      if (error instanceof PayoutProviderError && error.rejected) {
        await sql.query(`select wallet_settle_payout($1,'failed',null,$2)`, [payout.id, error.message]);
        outcomes[payout.id] = "failed";
      } else if (payout.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS) {
        await sql.query(`select wallet_settle_payout($1,'needs_attention',null,$2)`,
          [payout.id, "Payout provider did not confirm the transfer after repeated attempts"]);
        outcomes[payout.id] = "needs_attention";
      } else {
        await sql.query(
          `update wallet_payouts set lease_token=null, lease_until=null,
                  next_attempt_at=now() + make_interval(secs => least(1800, 30 * power(2, dispatch_attempts))),
                  updated_at=now() where id=$1 and lease_token=$2`, [payout.id, token]);
        outcomes[payout.id] = "retry";
      }
    }
  }
  return outcomes;
}

/** Read back payouts the provider has accepted but not yet finished. */
export async function reconcilePayouts(limit = 50) {
  const sql = await getSql();
  const rows = await sql.query<{ id: string; driver_key: string; provider_reference: string | null; net_amount: string }>(
    `select id, driver_key, provider_reference, net_amount::text from wallet_payouts
      where status='processing' and updated_at < now() - interval '1 minute'
      order by updated_at limit $1`, [Math.max(1, Math.min(limit, 200))]);
  const outcomes: Record<string, string> = {};
  for (const payout of rows) {
    try {
      const driver = await getPayoutDriver(payout.driver_key);
      const state = await driver.getPayout(payout.id, payout.provider_reference);
      if (!state) {
        await sql.query(`select wallet_settle_payout($1,'needs_attention',$2,$3)`,
          [payout.id, payout.provider_reference, "Provider has no record of an accepted payout"]);
        outcomes[payout.id] = "needs_attention";
      } else {
        outcomes[payout.id] = await settle(payout, state);
        if (outcomes[payout.id] === "processing")
          await sql.query(`update wallet_payouts set updated_at=now() where id=$1`, [payout.id]);
      }
    } catch {
      outcomes[payout.id] = "retry";
    }
  }
  return outcomes;
}

export class PayoutWebhookError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Provider notification: authenticate, then re-read the payout. The body is only a hint. */
export async function handlePayoutWebhook(input: { rawBody: string; headers: Headers }) {
  if (input.rawBody.length > 64 * 1024) throw new PayoutWebhookError("Payload too large", 413);
  const sql = await getSql();
  const keys = await sql.query<{ driver_key: string }>(
    `select distinct driver_key from wallet_payouts where status in ('requested','processing','needs_attention')`);
  const candidates = new Set(keys.map((k) => k.driver_key));
  try { candidates.add(activePayoutDriverKey()); } catch { /* payouts not configured */ }
  const verified: PayoutDriver[] = [];
  for (const key of candidates) {
    try {
      const driver = await getPayoutDriver(key);
      if (!driver.verifyWebhook || !driver.parseWebhook) continue;
      const signature = driver.webhookSignatureHeaders?.map((h) => input.headers.get(h)).find(Boolean) ?? null;
      if (await driver.verifyWebhook(input.rawBody, signature)) verified.push(driver);
    } catch { /* misconfigured driver must not block others */ }
  }
  if (verified.length !== 1) throw new PayoutWebhookError("Invalid webhook signature", 401);
  const driver = verified[0];
  const notice = await driver.parseWebhook!(input.rawBody).catch(() => null);
  if (!notice) throw new PayoutWebhookError("Invalid webhook payload", 400);
  const [payout] = await sql.query<{ id: string; driver_key: string; provider_reference: string | null; net_amount: string; status: string }>(
    `select id, driver_key, provider_reference, net_amount::text, status from wallet_payouts where id=$1`, [notice.payoutId]);
  if (!payout || payout.driver_key !== driver.key) throw new PayoutWebhookError("Unknown payout", 404);
  if (payout.status === "paid" || payout.status === "failed") return { payoutId: payout.id, status: payout.status, duplicate: true };
  const state = await driver.getPayout(payout.id, payout.provider_reference ?? notice.providerReference);
  if (!state) return { payoutId: payout.id, status: payout.status, pending: true };
  return { payoutId: payout.id, status: await settle(payout, state) };
}

export async function runWalletSettlement() {
  const sql = await getSql();
  const [released] = await sql.query<{ count: number }>(`select release_matured_wallet_funds(200) as count`);
  const dispatched = await dispatchPayouts({ limit: 25 });
  const reconciled = await reconcilePayouts(50);
  return { released: Number(released?.count ?? 0), dispatched, reconciled };
}

export async function enableWalletForMerchant(merchantId: string, adminId: string) {
  const sql = await getSql();
  const [row] = await sql.query<{ result: { merchantId: string; settlementModel: string; changed: boolean } }>(
    `select wallet_enable_for_merchant($1,$2) as result`, [merchantId, adminId]);
  return row.result;
}
