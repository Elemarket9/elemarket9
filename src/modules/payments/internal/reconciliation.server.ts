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
        verified.status === "completed"
          ? "completed"
          : verified.status === "failed"
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

  await recordMetric("payment.reconciliation.sweep", { metadata: { ...summary } });
  return summary;
}
