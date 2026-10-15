import { getSql, withTransaction, type Sql } from "@/lib/db";
import {
  getPaymentAdapter,
  assertPaymentInitializationReady,
  getPaymentCallbackOrigin,
} from "@/modules/payments/public/adapters/registry";
import { normalizeProviderKey } from "@/modules/payments/public/provider-policy.server";
import { env, getElemarketEnvironment } from "@/lib/env.server";

function validateCheckoutUrl(value: string | undefined, providerKey: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("/")) {
    if (getElemarketEnvironment() === "development" || getElemarketEnvironment() === "preview")
      return value;
    throw new Error("Payment provider checkout URL must be absolute HTTPS");
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error("Unsafe payment provider checkout URL");
  const envKey = `ELEMARKET_PAYMENT_${providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_CHECKOUT_HOSTS`;
  const hosts = (env(envKey) ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.includes(url.hostname.toLowerCase()))
    throw new Error("Payment provider checkout host is not approved");
  return url.toString();
}

export async function createFinancingDepositExternalIntent(input: {
  depositPaymentId: string;
  userId: string;
}) {
  const prepared = await withTransaction(async (sql) => {
    await sql.query(`select pg_advisory_xact_lock(hashtext($1))`, [
      `elemarket:financing-deposit:${input.depositPaymentId}`,
    ]);
    const rows = await sql.query<any>(
      `select d.id,d.application_id,d.user_id,d.financing_provider_id,d.payment_provider_key,d.provider_account_ref,d.amount::text as amount,d.currency,d.method,d.status,u.email
      from financing_deposit_payments d join "user" u on u.id=d.user_id
      where d.id=$1 and d.user_id=$2 limit 1 for update of d`,
      [input.depositPaymentId, input.userId],
    );
    if (rows.length !== 1) throw new Error("Financing deposit payment not found");
    const d = rows[0];
    if (d.status === "completed")
      return {
        done: true as const,
        result: { depositPaymentId: d.id, status: "completed", checkoutUrl: null, existing: true },
      };
    if (d.status !== "initiated" && d.status !== "authorized")
      throw new Error("Financing deposit payment is not startable");
    const providerKey = normalizeProviderKey(d.payment_provider_key);
    const providers = await sql.query<any>(
      `select provider_key,driver_key from payment_providers where provider_key=$1 and method=$2 and status='active'`,
      [providerKey, d.method],
    );
    if (!providers[0]) throw new Error("Payment provider is unavailable for financing deposit");
    const account = await sql.query(
      `select 1 from financing_provider_payment_accounts where financing_provider_id=$1 and payment_provider_key=$2 and provider_account_ref=$3 and status='active'`,
      [d.financing_provider_id, providerKey, d.provider_account_ref],
    );
    if (!account.length) throw new Error("Financing provider deposit account is unavailable");

    const adapter = await getPaymentAdapter(providerKey, providers[0].driver_key ?? undefined);
    assertPaymentInitializationReady(adapter, providerKey);
    if (adapter.supportsDirectSubaccountSettlement !== true)
      throw new Error(
        "Payment provider adapter does not support direct financing-provider deposit settlement",
      );
    const existing = await sql.query<any>(
      `select id,attempt_no as "attemptNo",provider_reference as "providerReference",checkout_url as "checkoutUrl",status from financing_deposit_payment_attempts where deposit_payment_id=$1 and status in ('initiated','pending','authorized') order by attempt_no desc limit 1 for update`,
      [d.id],
    );
    let attempt = existing[0];
    if (!attempt) {
      const n = await sql.query<{ n: number }>(
        `select coalesce(max(attempt_no),0)+1 as n from financing_deposit_payment_attempts where deposit_payment_id=$1`,
        [d.id],
      );
      const id = `fdpa_${crypto.randomUUID().replaceAll("-", "")}`;
      await sql.query(
        `insert into financing_deposit_payment_attempts(id,deposit_payment_id,attempt_no,provider_key,status) values($1,$2,$3,$4,'initiated')`,
        [id, d.id, n[0]?.n ?? 1, providerKey],
      );
      attempt = { id, attemptNo: n[0]?.n ?? 1, status: "initiated" };
    }
    if (attempt.providerReference && attempt.checkoutUrl) {
      return {
        done: true as const,
        result: {
          depositPaymentId: d.id,
          attemptId: attempt.id,
          status: attempt.status,
          checkoutUrl: validateCheckoutUrl(attempt.checkoutUrl, providerKey),
          existing: true,
        },
      };
    }
    const claim = crypto.randomUUID();
    const claimed = await sql.query(
      `update financing_deposit_payment_attempts set initiation_token=$2,initiation_expires_at=now()+interval '2 minutes',status='pending',updated_at=now()
      where id=$1 and provider_reference is null and (initiation_token is null or initiation_expires_at<now()) returning id`,
      [attempt.id, claim],
    );
    if (!claimed.length)
      return {
        done: true as const,
        result: {
          depositPaymentId: d.id,
          attemptId: attempt.id,
          status: "pending",
          checkoutUrl: null,
          initializing: true,
        },
      };
    return { done: false as const, d, providerKey, adapter, attemptId: attempt.id, claim };
  });
  if (prepared.done) return prepared.result;

  const adapter = prepared.adapter;
  const publicUrl = getPaymentCallbackOrigin();
  const callbackUrl = publicUrl
    ? `${publicUrl.replace(/\/$/, "")}/financing/deposit-return?depositPaymentId=${encodeURIComponent(prepared.d.id)}`
    : undefined;
  const external = await adapter.createPayment({
    paymentId: prepared.d.id,
    attemptId: prepared.attemptId,
    amount: String(prepared.d.amount),
    currency: prepared.d.currency,
    method: prepared.d.method,
    customerEmail: String(prepared.d.email),
    merchantSubaccount: prepared.d.provider_account_ref,
    customerReference: `financing_deposit:${prepared.d.application_id}`,
    idempotencyKey: prepared.attemptId,
    callbackUrl,
  });
  const safe = validateCheckoutUrl(external.checkoutUrl, prepared.providerKey);
  const initializedStatus = external.status === "failed" ? "failed" : "pending";
  const sql = await getSql();
  const bound = await sql.query(
    `update financing_deposit_payment_attempts set provider_reference=$1,checkout_url=$2,status=$3,metadata=$4::jsonb,initiation_token=null,initiation_expires_at=null,updated_at=now() where id=$5 and initiation_token=$6 returning id`,
    [
      external.providerReference,
      safe ?? null,
      initializedStatus,
      JSON.stringify(external.metadata ?? {}),
      prepared.attemptId,
      prepared.claim,
    ],
  );
  if (!bound.length) throw new Error("Financing deposit initiation lease lost");
  await sql.query(
    `update financing_deposit_payments set provider_reference=coalesce(provider_reference,$1),status=case when $2='failed' and status='initiated' then 'failed' else status end,updated_at=now() where id=$3`,
    [external.providerReference, initializedStatus, prepared.d.id],
  );
  if (initializedStatus === "failed")
    await sql.query(
      `update customer_financing_applications set initial_deposit_status='failed',updated_at=now() where id=$1 and initial_deposit_status='pending' and exists(select 1 from financing_deposit_payments where id=$2 and status='failed')`,
      [prepared.d.application_id, prepared.d.id],
    );
  // Only the verified webhook path may authorize or confirm a deposit.
  return {
    depositPaymentId: prepared.d.id,
    attemptId: prepared.attemptId,
    status: initializedStatus,
    checkoutUrl: safe ?? null,
    existing: false,
  };
}

export async function applyFinancingDepositWebhook(input: {
  providerKey: string;
  eventId: string;
  providerReference: string;
  status: "authorized" | "completed" | "failed" | "refunded";
  amount: number;
  currency: string;
  payloadHash: string;
}) {
  return withTransaction((sql) => applyFinancingDepositEvent(sql, input));
}

async function applyFinancingDepositEvent(
  sql: Sql,
  input: Parameters<typeof applyFinancingDepositWebhook>[0],
) {
  const rows = await sql.query<any>(
    `select d.*,a.id as attempt_id,a.status as attempt_status from financing_deposit_payment_attempts a join financing_deposit_payments d on d.id=a.deposit_payment_id where a.provider_key=$1 and a.provider_reference=$2 limit 1 for update of a,d`,
    [input.providerKey, input.providerReference],
  );
  if (!rows.length) return null;
  const d = rows[0];
  if (
    !Number.isFinite(input.amount) ||
    input.amount <= 0 ||
    Math.abs(Number(d.amount) - Number(input.amount)) > 0.001 ||
    d.currency !== input.currency
  )
    throw new Error("Financing deposit webhook amount mismatch");
  await sql.query(
    `insert into financing_deposit_webhook_events(provider_key,event_id,provider_reference,payload_hash,status) values($1,$2,$3,$4,$5) on conflict(provider_key,event_id) do nothing`,
    [input.providerKey, input.eventId, input.providerReference, input.payloadHash, input.status],
  );
  const ev = await sql.query<any>(
    `select * from financing_deposit_webhook_events where provider_key=$1 and event_id=$2 for update`,
    [input.providerKey, input.eventId],
  );
  if (ev[0]?.payload_hash !== input.payloadHash)
    throw new Error("Financing deposit webhook replay payload mismatch");
  if (ev[0]?.processed_at) return { duplicate: true, depositPaymentId: d.id, status: d.status };
  const next =
    input.status === "completed"
      ? "completed"
      : input.status === "authorized"
        ? "authorized"
        : input.status === "refunded"
          ? "refunded"
          : "failed";
  const allowed =
    (d.status === "initiated" && ["authorized", "completed", "failed"].includes(next)) ||
    (d.status === "authorized" && ["completed", "failed"].includes(next)) ||
    (d.status === "completed" && next === "refunded") ||
    d.status === next;
  if (!allowed) throw new Error("Invalid financing deposit state transition");
  await sql.query(
    `update financing_deposit_payments set status=$2,provider_reference=coalesce(provider_reference,$3),updated_at=now() where id=$1`,
    [d.id, next, input.providerReference],
  );
  await sql.query(
    `update financing_deposit_payment_attempts set status=case when $2='refunded' then 'failed' else $2 end,updated_at=now() where id=$1`,
    [d.attempt_id, next],
  );
  await sql.query(
    `update customer_financing_applications set initial_deposit_status=$2,updated_at=now() where id=$1`,
    [d.application_id, next === "completed" ? "paid" : next],
  );
  await sql.query(
    `update financing_deposit_webhook_events set processed_at=now() where provider_key=$1 and event_id=$2`,
    [input.providerKey, input.eventId],
  );
  return {
    duplicate: false,
    depositPaymentId: d.id,
    applicationId: d.application_id,
    status: next,
  };
}

export async function completePreviewFinancingDepositServer(input: {
  depositPaymentId: string;
  userId: string;
}) {
  if (
    getElemarketEnvironment() !== "development" ||
    env("ELEMARKET_ENABLE_PREVIEW_SETTLEMENT") !== "1"
  )
    throw new Error("Preview financing deposits are disabled");
  return withTransaction(async (sql) => {
    const rows = await sql.query<any>(
      `select id,application_id,status,payment_provider_key from financing_deposit_payments where id=$1 and user_id=$2 for update`,
      [input.depositPaymentId, input.userId],
    );
    if (rows.length !== 1) throw new Error("Financing deposit payment not found");
    if (!rows[0].payment_provider_key?.toLowerCase().startsWith("preview"))
      throw new Error("Only explicit preview providers can simulate settlement");
    if (rows[0].status === "completed") return { completed: true, replayed: true };
    const attempts = await sql.query(
      `select id from financing_deposit_payment_attempts where deposit_payment_id=$1 and provider_key=$2 and provider_reference is not null and status in ('initiated','pending','authorized')`,
      [rows[0].id, rows[0].payment_provider_key],
    );
    if (!attempts.length) throw new Error("Preview deposit payment has not been initialized");
    if (!["initiated", "authorized"].includes(rows[0].status))
      throw new Error("Financing deposit payment is not completable");
    await sql.query(
      `update financing_deposit_payments set status='completed',provider_reference=coalesce(provider_reference,$2),updated_at=now() where id=$1`,
      [rows[0].id, `preview_${rows[0].id}`],
    );
    await sql.query(
      `update financing_deposit_payment_attempts set status='completed',provider_reference=coalesce(provider_reference,id),updated_at=now() where deposit_payment_id=$1 and status in ('initiated','pending','authorized')`,
      [rows[0].id],
    );
    await sql.query(
      `update customer_financing_applications set initial_deposit_status='paid',updated_at=now() where id=$1`,
      [rows[0].application_id],
    );
    return { completed: true, replayed: false };
  });
}

export async function retryFinancingDepositPaymentServer(input: {
  depositPaymentId: string;
  userId: string;
}) {
  await withTransaction(async (sql) => {
    const rows = await sql.query<any>(
      `select id,application_id,status from financing_deposit_payments where id=$1 and user_id=$2 for update`,
      [input.depositPaymentId, input.userId],
    );
    if (rows.length !== 1) throw new Error("Financing deposit payment not found");
    if (rows[0].status === "completed") return;
    if (rows[0].status !== "failed")
      throw new Error("Only a failed financing deposit can be retried");
    await sql.query(
      `update financing_deposit_payments set status='initiated',provider_reference=null,updated_at=now() where id=$1`,
      [rows[0].id],
    );
    await sql.query(
      `update customer_financing_applications set initial_deposit_status='pending',updated_at=now() where id=$1`,
      [rows[0].application_id],
    );
  });
  return createFinancingDepositExternalIntent(input);
}

/** Recover lost deposit webhooks through independent provider verification. */
export async function reconcileFinancingDeposits(limit = 25) {
  const sql = await getSql();
  const summary = {
    scanned: 0,
    settled: 0,
    markedFailed: 0,
    mismatches: 0,
    skippedNoVerifier: 0,
    providerErrors: 0,
  };
  const parsed = Number(env("ELEMARKET_PAYMENT_RECONCILE_AFTER_MINUTES") ?? "15");
  const minutes = Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1440 ? parsed : 15;
  const boundedLimit = Number.isSafeInteger(limit) ? Math.min(50, Math.max(1, limit)) : 25;
  const candidates = await sql.query<{ id: string }>(
    `select d.id from financing_deposit_payments d
       where d.status in ('initiated','authorized') and d.provider_reference is not null
         and d.updated_at < now() - ($1 * interval '1 minute')
       order by d.updated_at limit $2`,
    [minutes, boundedLimit],
  );
  const deadline = Date.now() + 20_000;
  for (const candidate of candidates) {
    if (Date.now() + 10_000 >= deadline) break;
    try {
      const outcome = await withTransaction(async (tx) => {
        const lock = await tx.query<{ acquired: boolean }>(
          "select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",
          [`elemarket:deposit-reconciliation:${candidate.id}`],
        );
        if (!lock[0]?.acquired) return;
        const rows = await tx.query<{
          id: string;
          amount: string;
          currency: string;
          provider_reference: string;
          payment_provider_key: string;
          driver_key: string | null;
        }>(
          `select d.id,d.amount::text,d.currency,d.provider_reference,d.payment_provider_key,p.driver_key
             from financing_deposit_payments d join payment_providers p on p.provider_key=d.payment_provider_key and p.status='active'
            where d.id=$1 and d.status in ('initiated','authorized')
              and d.provider_reference is not null and d.updated_at < now() - ($2 * interval '1 minute')
            for update of d skip locked`,
          [candidate.id, minutes],
        );
        const deposit = rows[0];
        if (!deposit) return;
        summary.scanned++;
        const adapter = await getPaymentAdapter(
          deposit.payment_provider_key,
          deposit.driver_key ?? undefined,
        );
        if (!adapter.verifyTransaction) {
          summary.skippedNoVerifier++;
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let verified;
        try {
          verified = await Promise.race([
            adapter.verifyTransaction(deposit.provider_reference),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Deposit verification timed out")), 10_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (
          !Number.isFinite(verified.amount) ||
          verified.reference !== deposit.provider_reference ||
          verified.currency !== deposit.currency ||
          Math.abs(verified.amount - Number(deposit.amount)) > 0.001
        ) {
          summary.mismatches++;
          return;
        }
        if (verified.status !== "completed" && verified.status !== "failed") return;
        const payload = JSON.stringify({
          reference: verified.reference,
          status: verified.status,
          amount: verified.amount,
          currency: verified.currency,
        });
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
        const hash = Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        const result = await applyFinancingDepositEvent(tx, {
          providerKey: deposit.payment_provider_key,
          eventId: `deposit-reconciliation:${hash}`,
          providerReference: verified.reference,
          status: verified.status,
          amount: verified.amount,
          currency: verified.currency,
          payloadHash: hash,
        });
        if (result && !result.duplicate) return verified.status;
      });
      if (outcome === "completed") summary.settled++;
      else if (outcome === "failed") summary.markedFailed++;
    } catch {
      summary.providerErrors++;
    }
  }
  return summary;
}
