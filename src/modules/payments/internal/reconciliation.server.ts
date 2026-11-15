import { getSql } from "@/lib/db";
import { recordMetric } from "@/lib/observability/logger.server";
import { emitSecurityAlert } from "@/lib/observability/security-alert.server";
import { getPaymentAdapter } from "@/modules/payments/internal/adapters/registry";

/**
 * Provider-neutral payment reconciliation.
 *
 * Webhooks can be lost or delayed; this sweep verifies stale in-flight payments
 * directly with the configured provider through the adapter contract
 * (`verifyTransaction`) — the same trust boundary the webhook "completed" path
 * uses. Verified state is applied through the identical `apply_payment_webhook`
 * SQL path, so every state transition, reservation, and audit rule is reused.
 * No provider is named here; any active `payment_providers` row with a driver
 * and a working `verifyTransaction` implementation is reconciled.
 */

function reconcileAfterMinutes(): number {
  const parsed = Number.parseInt(process.env.ELEMARKET_PAYMENT_RECONCILE_AFTER_MINUTES ?? "15", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 24 * 60 ? parsed : 15;
}

function stuckAlertAfterHours(): number {
  const parsed = Number.parseInt(process.env.ELEMARKET_PAYMENT_STALE_ALERT_HOURS ?? "24", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 24 * 30 ? parsed : 24;
}

type StalePayment = {
  id: string;
  order_id: string;
  provider_key: string;
  driver_key: string | null;
  provider_reference: string;
  amount: string;
  amount_number: number;
  currency: string;
  status: "initiated" | "authorized";
  updated_at: string;
};

function canonicalPayloadHash(input: {
  paymentId: string;
  providerReference: string;
  amount: number;
  currency: string;
}): Promise<string> {
  const canonical = JSON.stringify({
    paymentId: input.paymentId,
    providerReference: input.providerReference,
    amount: input.amount,
    currency: input.currency,
    source: "reconciliation",
  });
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(canonical))
    .then((digest) =>
      Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
    );
}

export type ReconciliationSummary = {
  scanned: number;
  settled: number;
  markedFailed: number;
  mismatches: number;
  skippedNoVerifier: number;
  providerErrors: number;
  stuckAlerts: number;
};

/**
 * Verify stale in-flight payments with their provider and settle or fail them
 * through the standard webhook-application path. Safe to run every minute:
 * each payment is claimed with a short lease so overlapping invocations do not
 * double-verify, and the reconciliation event id is idempotent per payment.
 */
export async function reconcileStalePayments(limit = 50): Promise<ReconciliationSummary> {
  const sql = await getSql();
  const summary: ReconciliationSummary = {
    scanned: 0,
    settled: 0,
    markedFailed: 0,
    mismatches: 0,
    skippedNoVerifier: 0,
    providerErrors: 0,
    stuckAlerts: 0,
  };

  const stale = await sql.query<StalePayment>(
    `select p.id, p.order_id, p.provider_key, pp.driver_key,
            p.provider_reference, p.amount::text as amount, p.amount as amount_number,
            p.currency, p.status, p.updated_at
       from payments p
       join payment_providers pp
         on pp.provider_key = p.provider_key and pp.status = 'active'
      where p.status in ('initiated','authorized')
        and p.provider_reference is not null
        and p.created_at < now() - ($1 * interval '1 minute')
        and (p.reconciliation_attempted_at is null or p.reconciliation_attempted_at < now() - ($1 * interval '1 minute'))
      order by p.created_at asc
      limit $2`,
    [reconcileAfterMinutes(), limit],
  );

  const stuck = await sql.query<{ id: string }>(
    `select id from payments
      where status in ('initiated','authorized')
        and provider_reference is not null
        and created_at < now() - ($1 * interval '1 hour')
      limit 100`,
    [stuckAlertAfterHours()],
  );
  for (const row of stuck) {
    summary.stuckAlerts += 1;
    await emitSecurityAlert({
      alertKey: `payment-stuck:${row.id}`,
      severity: "warn",
      eventName: "security.payment_reconciliation_stuck",
      message: "Payment remained in-flight past the stale threshold and needs operator review.",
      metadata: { paymentId: row.id },
      dedupeKey: `payment-stuck:${row.id}:${new Date().toISOString().slice(0, 13)}`,
    });
  }

  for (const payment of stale) {
    // Short claim lease: concurrent cron invocations must not both verify.
    const claim = await sql.query<{ id: string }>(
      `update payments
          set reconciliation_attempted_at = now()
        where id = $1
          and status in ('initiated','authorized')
          and (reconciliation_attempted_at is null or reconciliation_attempted_at < now() - ($2 * interval '1 minute'))
        returning id`,
      [payment.id, reconcileAfterMinutes()],
    );
    if (!claim[0]) continue;
    summary.scanned += 1;

    try {
      const adapter = await getPaymentAdapter(
        payment.provider_key,
        payment.driver_key ?? undefined,
      );
      if (!adapter.verifyTransaction) {
        summary.skippedNoVerifier += 1;
        continue;
      }

      let verified: { status: string; reference: string; amount: number; currency: string };
      try {
        verified = await adapter.verifyTransaction(payment.provider_reference);
      } catch {
        summary.providerErrors += 1;
        await recordMetric("payment.reconciliation.provider_error", {
          entityId: payment.id,
          metadata: { providerKey: payment.provider_key },
        });
        continue;
      }

      const mismatch =
        verified.reference !== payment.provider_reference ||
        verified.currency !== payment.currency ||
        (!Number.isFinite(verified.amount)
          ? Infinity
          : Math.abs(verified.amount - Number(payment.amount_number))) > 0.001;

      if (mismatch) {
        summary.mismatches += 1;
        await emitSecurityAlert({
          alertKey: `payment-recon-mismatch:${payment.id}`,
          severity: "error",
          eventName: "security.payment_reconciliation_mismatch",
          message: "Provider verification disagrees with the recorded payment; refusing to apply.",
          metadata: {
            paymentId: payment.id,
            providerKey: payment.provider_key,
            providerStatus: verified.status,
            providerAmount: verified.amount,
            providerCurrency: verified.currency,
            localAmount: payment.amount,
            localCurrency: payment.currency,
          },
          dedupeKey: `payment-recon-mismatch:${payment.id}`,
        });
        continue;
      }

      // Only terminal provider states are applied; everything else stays
      // in-flight for the next sweep.
      const appliedStatus =
        verified.status === "completed" || verified.status === "success"
          ? "completed"
          : verified.status === "failed" ||
              verified.status === "abandoned" ||
              verified.status === "reversed" ||
              verified.status === "cancelled"
            ? "failed"
            : null;
      if (!appliedStatus) continue;

      const payloadHash = await canonicalPayloadHash({
        paymentId: payment.id,
        providerReference: payment.provider_reference,
        amount: payment.amount_number,
        currency: payment.currency,
      });
      const eventId = `recon:${payment.id}`;
      try {
        const rows = await sql.query<{ result: unknown }>(
          `select apply_payment_webhook($1,$2,$3,$4,$5,$6,$7,$8,$9) as result`,
          [
            payment.provider_key,
            eventId,
            appliedStatus === "completed" ? "reconciliation.settled" : "reconciliation.failed",
            payment.provider_reference,
            appliedStatus,
            payment.amount_number,
            payment.currency,
            payloadHash,
            null,
          ],
        );
        const result = rows[0]?.result;
        const duplicate =
          !!result &&
          typeof result === "object" &&
          "duplicate" in result &&
          result.duplicate === true;
        if (appliedStatus === "completed") summary.settled += duplicate ? 0 : 1;
        else summary.markedFailed += duplicate ? 0 : 1;
        await recordMetric(`payment.reconciliation.${appliedStatus}`, {
          entityId: payment.id,
          metadata: { providerKey: payment.provider_key, duplicate },
        });
      } catch (error) {
        // e.g. the order's reservations expired before the late success arrived.
        // The payment stays in-flight and the next sweep re-evaluates it; an
        // operator-facing stuck alert fires once the stale threshold passes.
        summary.providerErrors += 1;
        await recordMetric("payment.reconciliation.apply_failed", {
          entityId: payment.id,
          metadata: {
            providerKey: payment.provider_key,
            status: appliedStatus,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    } catch {
      // Adapter construction, application and telemetry failures must not stop other payments.
      summary.providerErrors += 1;
    }
  }

  // Group charges have no separate merchant payment_attempts. Reconcile their
  // single provider reference independently, never initiate a second charge.
  try {
    const group = await reconcileStaleGroupCharges(20);
    await recordMetric("payment.group_reconciliation.sweep", { metadata: { ...group } });
  } catch {
    summary.providerErrors += 1;
  }
  await recordMetric("payment.reconciliation.sweep", { metadata: { ...summary } });
  return summary;
}


type UnsettledGroup = {
  id:string; group_id:string; provider_key:string; driver_key:string|null;
  provider_reference:string; currency:string; amount:string;
};
export async function reconcileStaleGroupCharges(limit=20) {
  if (!Number.isInteger(limit) || limit<1 || limit>100) throw new Error("Invalid group reconciliation limit");
  const sql=await getSql();
  const counters={scanned:0,settled:0,failed:0,mismatches:0,pending:0,providerErrors:0};
  const groups=await sql.query<UnsettledGroup>(
    `select g.id,g.group_id,g.provider_key,p.driver_key,g.provider_reference,g.currency,
        g.amount::text as amount
       from checkout_group_charges g
       join payment_providers p on p.provider_key=g.provider_key and p.status='active'
      where g.status in ('initializing','pending','needs_attention')
        and g.updated_at < now()-interval '3 minutes'
      order by g.created_at asc limit $1`,[limit]);
  for (const g of groups) {
    // Atomic DB throttle: the order remains reserved while an external outcome
    // is uncertain. Multiple workers may read, but only one claims a sweep.
    const claim=await sql.query<{id:string}>(`update checkout_group_charges
        set updated_at=now() where id=$1 and status in ('initializing','pending','needs_attention')
        and updated_at<now()-interval '3 minutes' returning id`,[g.id]);
    if (!claim[0])continue;
    counters.scanned++;
    try {
      const adapter=await getPaymentAdapter(g.provider_key,g.driver_key??undefined);
      if (!adapter.verifyTransaction) {counters.providerErrors++;continue;}
      const state=await adapter.verifyTransaction(g.provider_reference);
      if (state.reference!==g.provider_reference||state.currency!==g.currency||
          !Number.isFinite(state.amount)||Math.abs(state.amount-Number(g.amount))>0.001) {
        counters.mismatches++;
        await sql.query(`update checkout_group_charges set status='needs_attention',
          failure_reason='payment provider reconciliation disagrees with the original group charge'
          where id=$1 and status not in ('completed','failed')`,[g.id]);
        await emitSecurityAlert({alertKey:`group-charge-mismatch:${g.id}`,
          severity:"error",eventName:"security.group_charge_reconciliation_mismatch",
          message:"Group charge verification disagrees with the frozen provider reference, currency or amount.",
          metadata:{groupId:g.group_id,chargeId:g.id,providerKey:g.provider_key},
          dedupeKey:`group-charge-mismatch:${g.id}`});
        continue;
      }
      const resultStatus=state.status==="completed"||state.status==="success"?"completed":
        state.status==="failed"?"failed":null;
      if (!resultStatus) {counters.pending++;continue;}
      const payloadHash=await canonicalPayloadHash({
        paymentId:g.id,providerReference:g.provider_reference,
        amount:state.amount,currency:state.currency,
      });
      const eventId=`group-recon:${g.id}:${resultStatus}`;
      const [outcome]=await sql.query<{result:{status?:string;reconciliationRequired?:boolean;duplicate?:boolean}}>(
        `select apply_checkout_group_charge_event($1,$2,$3,$4,$5,$6,$7,$8) as result`,
        [g.provider_key,eventId,`reconciliation.${resultStatus}`,g.provider_reference,
         resultStatus,state.amount,state.currency,payloadHash]);
      if(outcome?.result?.reconciliationRequired){counters.mismatches++;continue;}
      if(outcome?.result?.status===resultStatus||outcome?.result?.duplicate){
        if(resultStatus==="completed")counters.settled++;
        else counters.failed++;
      }
    }catch{
      // Never restart a provider transaction after a lost response.
      counters.providerErrors++;
    }
  }
  return counters;
}
