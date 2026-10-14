import { assertCommerceExecutionAllowed } from "@/lib/security/launch-profile.mjs";
import { getSql } from "@/lib/db";
import { getPaymentAdapter } from "@/modules/payments/internal/adapters/registry";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";

async function executeProviderRefundForActor(input: { requestId: string; actorId: string }) {
  const sql = await getSql();
  const actor = await sql.query<{ role: string; requested_by: string | null }>(
    `
    select u.role, r.requested_by
      from provider_refund_requests r
      left join "user" u on u.id=$2
     where r.id=$1
     limit 1
  `,
    [input.requestId, input.actorId],
  );
  if (!actor[0]) throw new Error("Refund request not found");
  if (actor[0].role !== "admin" && actor[0].requested_by !== input.actorId) {
    throw new Error("Refund request is not authorized for this actor");
  }
  return executeRefund(input.requestId);
}

async function executeRefund(requestId: string) {
  assertCommerceExecutionAllowed("refund execution");
  const sql = await getSql();
  const token = crypto.randomUUID();
  const claimed = await sql.query<any>(
    `
    update provider_refund_requests
       set execution_token=$2, execution_lease_until=now()+interval '2 minutes', updated_at=now()
     where id=$1 and status in ('requested','processing','needs_attention')
       and (execution_lease_until is null or execution_lease_until < now())
     returning *`,
    [requestId, token],
  );
  const request = claimed[0];
  if (!request) {
    const rows = await sql.query<any>(`select * from provider_refund_requests where id=$1`, [
      requestId,
    ]);
    if (!rows[0]) throw new Error("Refund request not found");
    return { requestId, status: rows[0].status, providerRefundId: rows[0].provider_refund_id };
  }
  try {
    const providers = await sql.query<{ driver_key: string | null }>(
      `select driver_key from payment_providers where provider_key=$1 and status='active'`,
      [request.provider_key],
    );
    if (!providers[0]) throw new Error("Refund provider is not active");
    const adapter = await getPaymentAdapter(
      request.provider_key,
      providers[0].driver_key ?? undefined,
    );
    const identity = {
      providerReference: request.provider_reference,
      amount: String(request.amount),
      currency: request.currency,
      idempotencyKey: `refund:${request.id}`,
    };
    let result;
    if (request.creation_attempted_at || request.status !== "requested") {
      if (!adapter.reconcileRefund)
        throw new Error(
          "Uncertain refund requires provider reconciliation; creation retry is disabled",
        );
      const verified = await adapter.reconcileRefund({
        ...identity,
        providerRefundId: request.provider_refund_id,
      });
      if (verified.status !== "not_found") result = verified;
      else if (adapter.supportsIdempotentRefunds !== true)
        throw new Error("Provider has not proved duplicate-safe refund creation");
    }
    if (!result) {
      if (!adapter.refundPayment) throw new Error("Configured provider does not support refunds");
      // Persist intent before calling the provider. A crash is an uncertain attempt.
      const permitted = await sql.query<{ id: string; provider_state_version: number }>(
        `update provider_refund_requests set status='processing',creation_attempted_at=coalesce(creation_attempted_at,now()),updated_at=now() where id=$1 and execution_token=$2 and execution_lease_until>now() and status in ('requested','processing','needs_attention') and provider_state_version=$3 returning id,provider_state_version`,
        [requestId, token, request.provider_state_version],
      );
      if (!permitted[0]) return currentRefund(requestId);
      request.provider_state_version = permitted[0].provider_state_version;
      result = await adapter.refundPayment({
        ...identity,
        customerNote: request.customer_note ?? undefined,
        merchantNote: request.merchant_note ?? undefined,
      });
    }
    if (!["processed", "processing", "needs_attention"].includes(result.status))
      throw new Error("Invalid provider refund status");
    await sql.query(
      `update provider_refund_requests set status=$1,provider_refund_id=coalesce($2,provider_refund_id),provider_response=$3::jsonb,processed_at=case when $1='processed' then coalesce(processed_at,now()) else processed_at end,execution_token=null,execution_lease_until=case when $1='processing' then now()+interval '2 minutes' else null end,updated_at=now() where id=$4 and execution_token=$5 and provider_state_version=$6 and status in ('requested','processing','needs_attention') and (provider_refund_id is null or $2::text is null or provider_refund_id=$2)`,
      [
        result.status,
        result.providerRefundId,
        JSON.stringify(result.metadata ?? {}),
        requestId,
        token,
        request.provider_state_version,
      ],
    );
  } catch (error) {
    await sql.query(
      `update provider_refund_requests set status='needs_attention',provider_response=$1::jsonb,execution_token=null,execution_lease_until=now()+interval '5 minutes',updated_at=now() where id=$2 and execution_token=$3 and provider_state_version=$4 and status in ('requested','processing','needs_attention')`,
      [
        JSON.stringify({
          error: error instanceof Error ? error.message : "Refund could not be confirmed",
        }),
        requestId,
        token,
        request.provider_state_version,
      ],
    );
    throw error;
  }
  return currentRefund(requestId);
}

async function currentRefund(requestId: string) {
  const sql = await getSql();
  const rows = await sql.query<any>(
    `select id,status,provider_refund_id from provider_refund_requests where id=$1`,
    [requestId],
  );
  return { requestId, status: rows[0]?.status, providerRefundId: rows[0]?.provider_refund_id };
}

/** Recover expired executions by reconciliation, never by blind creation. */
export async function reconcileProviderRefunds(limit = 50) {
  const sql = await getSql();
  const rows = await sql.query<{ id: string }>(
    `select id from provider_refund_requests where status in ('processing','needs_attention') and (execution_lease_until is null or execution_lease_until<now()) order by updated_at limit $1`,
    [limit],
  );
  let recovered = 0;
  let needsAttention = 0;
  for (const row of rows) {
    try {
      await executeRefund(row.id);
      recovered++;
    } catch {
      needsAttention++;
    }
  }
  return { scanned: rows.length, recovered, needsAttention };
}

/** Public financial boundary: resolve the actor from the authenticated session. */
export async function executeProviderRefundAsAuthenticatedUser(requestId: string) {
  const actorId = await requireFreshSession();
  const sql = await getSql();
  const rows = await sql.query<{ role: string }>(`select role from "user" where id=$1 limit 1`, [
    actorId,
  ]);
  if (rows[0]?.role === "admin") {
    await requireAdminForUserId(actorId, "admin.finance.refunds");
  }
  return executeProviderRefundForActor({ requestId, actorId });
}

/** Explicit admin-only financial boundary. Never accept a caller-supplied actor ID. */
export async function executeProviderRefundAsAdmin(requestId: string) {
  const actorId = await requireFreshSession();
  await requireAdminForUserId(actorId, "admin.finance.refunds");
  return executeProviderRefundForActor({ requestId, actorId });
}
