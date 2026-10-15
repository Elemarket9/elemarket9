import { getSql } from "@/lib/db";
import { requireCustomerPayment } from "@/modules/payments/internal/ownership.server";
import {
  getPaymentAdapter,
  assertPaymentInitializationReady,
  getPaymentCallbackOrigin,
} from "@/modules/payments/internal/adapters/registry";
import { recordMetric } from "@/lib/observability/logger.server";
import { emitSecurityAlert } from "@/lib/observability/security-alert.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { normalizeProviderKey } from "@/modules/payments/internal/provider-policy.server";
import { env, getElemarketEnvironment } from "@/lib/env.server";
import {
  PaymentProviderError,
  PaymentWebhookError,
} from "@/modules/payments/internal/payment-errors";

export type PaymentStatus = "initiated" | "authorized" | "completed" | "failed" | "refunded";

function validateProviderCheckoutUrl(
  value: string | undefined,
  providerKey: string,
): string | undefined {
  if (!value) return undefined;
  try {
    if (value.startsWith("/")) {
      if (getElemarketEnvironment() === "development" || getElemarketEnvironment() === "preview")
        return value;
      throw new Error("Provider checkout URL must be absolute HTTPS in shared environments");
    }
    const url = new URL(value);
    if (url.protocol === "https:") {
      if (url.username || url.password || url.hash || (url.port && url.port !== "443")) {
        throw new Error("Unsafe provider checkout URL");
      }
    } else {
      throw new Error("Provider checkout URL must use HTTPS");
    }
    const envKey = `ELEMARKET_PAYMENT_${providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_CHECKOUT_HOSTS`;
    const allowedHosts = (env(envKey) ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    if (!allowedHosts.length) throw new Error("Payment provider checkout hosts are not configured");
    if (!allowedHosts.includes(url.hostname.toLowerCase()))
      throw new Error("Provider checkout host is not approved");
    return url.toString();
  } catch {
    throw new Error("Provider returned an unsafe checkout URL");
  }
}

/** Provider adapter boundary. No provider is considered configured merely by being listed in the DB. */
export async function createExternalPaymentIntent(input: {
  paymentId: string;
  providerKey?: string;
  userId: string;
}) {
  const sql = await getSql();
  const owned = await requireCustomerPayment(input.paymentId, input.userId);
  const payment = {
    payment_id: owned.id,
    order_id: owned.order_id,
    amount: owned.amount,
    currency: owned.currency,
    method: owned.method,
    status: owned.status as PaymentStatus,
    provider_key: owned.provider_key,
  };
  const selectedProviderKey = input.providerKey ?? payment.provider_key;
  if (!selectedProviderKey) throw new Error("Payment provider is not selected");
  const normalizedProviderKey = normalizeProviderKey(selectedProviderKey);
  if (payment.status !== "initiated") throw new Error("Payment is not startable");
  if (payment.provider_key !== normalizedProviderKey) throw new Error("Payment provider mismatch");

  const provider = await sql.query<{
    provider_key: string;
    driver_key: string | null;
    requires_merchant_account: boolean;
  }>(
    `select provider_key, driver_key, requires_merchant_account from payment_providers where provider_key = $1 and method = $2 and status = 'active'`,
    [normalizedProviderKey, payment.method],
  );
  if (!provider[0]) throw new Error("Payment provider is not configured for production");

  // Check integration capability before creating or leasing a DB attempt.
  // A driver that cannot prove duplicate-safe initialization must never leave
  // a partly started attempt or initiate external money movement.
  const adapter = await getPaymentAdapter(
    normalizedProviderKey,
    provider[0].driver_key ?? undefined,
  );
  assertPaymentInitializationReady(adapter, normalizedProviderKey);
  if (
    provider[0].requires_merchant_account &&
    adapter.supportsDirectSubaccountSettlement !== true
  ) {
    throw new Error("Payment provider does not support direct merchant settlement");
  }

  const customerRows = await sql.query<{ email: string }>(
    `select email from "user" where id=$1 limit 1`,
    [input.userId],
  );
  const customerEmail = customerRows[0]?.email?.trim();
  if (!customerEmail) throw new Error("Customer email is required for payment");
  const subaccountRows = await sql.query<{ provider_account_ref: string }>(
    `select provider_account_ref from merchant_payment_accounts where merchant_id=(select merchant_id from orders where id=$1) and provider_key=$2 and status='active' limit 1`,
    [payment.order_id, normalizedProviderKey],
  );
  if (provider[0].requires_merchant_account && !subaccountRows[0]?.provider_account_ref)
    throw new Error("Merchant provider account is not configured");

  const attemptRows = await sql.query<{
    result: {
      paymentId: string;
      attemptId: string;
      attemptNo: number;
      status: "initiated" | "pending" | "authorized";
      existing?: boolean;
      providerReference?: string | null;
      checkoutUrl?: string | null;
    };
  }>(`select create_payment_attempt($1,$2,$3,$4,$5::jsonb) as result`, [
    payment.payment_id,
    normalizedProviderKey,
    payment.amount,
    payment.currency,
    JSON.stringify({ configured: true }),
  ]);
  const result = attemptRows[0]?.result;
  if (!result) throw new Error("Payment attempt could not be created");
  if (result.existing && result.providerReference && result.checkoutUrl) {
    return {
      ...result,
      providerReference: result.providerReference,
      checkoutUrl: validateProviderCheckoutUrl(result.checkoutUrl, normalizedProviderKey),
    };
  }
  const claimToken = crypto.randomUUID();
  const claimed = await sql.query<{ id: string }>(
    `update payment_attempts
        set initiation_token=$2, initiation_expires_at=now()+interval '2 minutes', updated_at=now()
      where id=$1 and provider_reference is null
        and (initiation_token is null or initiation_expires_at < now())
      returning id`,
    [result.attemptId, claimToken],
  );
  if (!claimed[0]) {
    return { ...result, status: "pending", initializing: true, checkoutUrl: null };
  }
  // An attempt can exist briefly without a provider reference while the external
  // provider call is in flight. Reuse the same attempt/idempotency key instead of
  // creating another charge. This also closes the pay-then-cancel race window.
  const publicUrl = getPaymentCallbackOrigin();
  const callbackUrl = publicUrl
    ? `${publicUrl.replace(/\/$/, "")}/payment/return?paymentId=${encodeURIComponent(result.paymentId)}`
    : undefined;
  const external = await adapter.createPayment({
    paymentId: result.paymentId,
    attemptId: result.attemptId,
    amount: String(payment.amount),
    currency: payment.currency,
    method: payment.method,
    customerEmail,
    merchantSubaccount: subaccountRows[0]?.provider_account_ref,
    idempotencyKey: result.attemptId,
    callbackUrl,
  });
  const safeCheckoutUrl = validateProviderCheckoutUrl(external.checkoutUrl, normalizedProviderKey);
  // Initialization is not proof of authorization or settlement.
  const initializedStatus = external.status === "failed" ? "failed" : "pending";
  const bound = await sql.query(
    `update payment_attempts set provider_reference=$1, checkout_url=$2, status=$3, metadata=$4::jsonb, initiation_token=null, initiation_expires_at=null, updated_at=now() where id=$5 and initiation_token=$6 returning id`,
    [
      external.providerReference,
      safeCheckoutUrl ?? null,
      initializedStatus,
      JSON.stringify(external.metadata ?? {}),
      result.attemptId,
      claimToken,
    ],
  );
  if (!bound[0]) {
    // The lease was lost while the provider call was in flight. Do not mutate
    // another request's attempt; the deterministic provider reference remains
    // recoverable through provider verification/reconciliation.
    throw new Error("Payment initiation lease lost before provider binding");
  }
  await sql.query(
    `update payments set provider_reference=coalesce(provider_reference,$1), updated_at=now() where id=$2 and status='initiated'`,
    [external.providerReference, payment.payment_id],
  );
  await recordMetric("payment.attempt.created", {
    userId: input.userId,
    entityId: input.paymentId,
    metadata: { providerKey: normalizedProviderKey, status: external.status },
  });
  return {
    ...result,
    status: initializedStatus,
    providerReference: external.providerReference,
    checkoutUrl: safeCheckoutUrl,
  };
}

export type FinancingDepositWebhook = {
  providerKey: string;
  eventId: string;
  providerReference: string;
  status: "authorized" | "completed" | "failed" | "refunded";
  amount: number;
  currency: string;
  payloadHash: string;
};
export type PaymentWebhookPorts = {
  applyFinancingDeposit: (
    input: FinancingDepositWebhook,
  ) => Promise<{ depositPaymentId?: string } | null | undefined>;
};

export async function handlePaymentWebhook(
  input: { providerKey?: string; rawBody: string; signature?: string | null; headers?: Headers },
  ports: PaymentWebhookPorts,
) {
  if (input.rawBody.length > 1024 * 1024) {
    throw new PaymentWebhookError("Webhook payload too large", { status: 413, retryable: false });
  }

  const sql = await getSql();
  const requestedProviderKey = input.providerKey?.trim() || undefined;
  if (requestedProviderKey && !/^[A-Za-z0-9_-]{2,64}$/.test(requestedProviderKey)) {
    throw new PaymentWebhookError("Invalid provider", { status: 400, retryable: false });
  }

  const providerRows = await sql.query<{
    provider_key: string;
    driver_key: string | null;
  }>(
    `select provider_key, driver_key
       from payment_providers
      where status='active'
      order by provider_key`,
  );
  if (!providerRows.length) {
    throw new PaymentWebhookError("No active payment provider is configured", {
      status: 503,
      retryable: true,
    });
  }

  const candidates = requestedProviderKey
    ? [
        ...providerRows.filter(
          (row) => row.provider_key === normalizeProviderKey(requestedProviderKey),
        ),
        ...providerRows.filter(
          (row) => row.provider_key !== normalizeProviderKey(requestedProviderKey),
        ),
      ]
    : providerRows;

  const verifiedProviders: Array<{
    provider_key: string;
    driver_key: string | null;
    adapter: Awaited<ReturnType<typeof getPaymentAdapter>>;
  }> = [];

  for (const row of candidates) {
    try {
      // One disabled/misconfigured adapter must not prevent another provider
      // from receiving a correctly signed notification.
      const adapter = await getPaymentAdapter(row.provider_key, row.driver_key ?? undefined);
      if (!adapter.verifyWebhook || !adapter.parseWebhook) continue;
      const signature =
        input.signature ??
        adapter.webhookSignatureHeaders
          ?.map((header) => input.headers?.get(header) ?? null)
          .find((value): value is string => Boolean(value)) ??
        null;
      if (await adapter.verifyWebhook(input.rawBody, signature)) {
        verifiedProviders.push({ ...row, adapter });
      }
    } catch {
      // A malformed/untrusted webhook must not reveal provider configuration.
    }
  }

  if (verifiedProviders.length !== 1) {
    void emitSecurityAlert({
      alertKey: "webhook-provider-resolution",
      severity: "error",
      eventName: "security.payment_webhook_provider_resolution_failed",
      message: "Payment webhook did not resolve to exactly one active provider.",
      metadata: {
        candidateCount: candidates.length,
        verifiedProviderCount: verifiedProviders.length,
      },
    });
    throw new PaymentWebhookError(
      verifiedProviders.length > 1 ? "Ambiguous webhook signature" : "Invalid webhook signature",
      { status: 401, retryable: false },
    );
  }

  const provider = verifiedProviders[0];
  const normalizedProviderKey = normalizeProviderKey(provider.provider_key);

  // Rate-limit after cryptographic provider resolution so a caller cannot select
  // an arbitrary provider bucket by changing a query parameter/header.
  await enforceRateLimit(`payment-webhook:${normalizedProviderKey}`, {
    windowSeconds: 60,
    maxRequests: 120,
  });

  if (!provider.adapter.parseWebhook) {
    throw new PaymentWebhookError("Provider webhook parsing is not supported", {
      status: 503,
      retryable: true,
    });
  }
  const body = await provider.adapter.parseWebhook(input.rawBody);
  if (!body) return { ignored: true };
  const eventStatuses: Record<string, string> = {
    "payment.authorized": "authorized",
    "payment.completed": "completed",
    "payment.failed": "failed",
    "refund.pending": "completed",
    "refund.processing": "completed",
    "refund.needs-attention": "completed",
    "refund.failed": "completed",
    "refund.processed": "refunded",
  };
  if (
    !Number.isFinite(body.amount) ||
    body.amount <= 0 ||
    eventStatuses[body.eventType] !== body.status ||
    typeof body.eventId !== "string" ||
    !body.eventId ||
    body.eventId.length > 256 ||
    typeof body.providerReference !== "string" ||
    !body.providerReference ||
    body.providerReference.length > 256 ||
    !/^[A-Z]{3}$/.test(body.currency)
  ) {
    throw new PaymentWebhookError("Provider webhook contract is invalid", {
      status: 400,
      retryable: false,
    });
  }

  const binding = await sql.query<{ id: string }>(
    `select id from payment_attempts where provider_key=$1 and provider_reference=$2 limit 1`,
    [normalizedProviderKey, body.providerReference],
  );
  const depositBinding = binding[0]
    ? []
    : await sql.query<{ id: string }>(
        `select id from financing_deposit_payment_attempts where provider_key=$1 and provider_reference=$2 limit 1`,
        [normalizedProviderKey, body.providerReference],
      );
  if (!binding[0] && !depositBinding[0]) {
    throw new PaymentWebhookError("Payment reference is not bound yet", {
      status: 503,
      retryable: true,
    });
  }

  // A nonterminal refund notification describes refund progress, not a deposit
  // payment. Its neutral "completed" status must never confirm a new deposit.
  if (
    depositBinding[0] &&
    body.eventType.startsWith("refund.") &&
    body.eventType !== "refund.processed"
  )
    return { ignored: true };

  // Refund lifecycle notifications never establish a new successful charge.
  // Their status is deliberately mapped to a neutral payment state by adapters;
  // the SQL reconciler applies their refund-specific transitions separately.
  if (body.status === "completed" && !body.eventType.startsWith("refund.")) {
    if (!provider.adapter.verifyTransaction) {
      throw new PaymentWebhookError(
        "Provider transaction verification is required for completed payments",
        { status: 503, retryable: true },
      );
    }
    try {
      const verified = await provider.adapter.verifyTransaction(body.providerReference);
      if (
        !Number.isFinite(verified.amount) ||
        !Number.isFinite(body.amount) ||
        verified.status !== "completed" ||
        verified.reference !== body.providerReference ||
        verified.currency !== body.currency ||
        Math.abs(verified.amount - body.amount) > 0.001
      ) {
        throw new PaymentWebhookError("Provider transaction verification failed", {
          status: 400,
          retryable: false,
        });
      }
    } catch (error) {
      if (error instanceof PaymentWebhookError) throw error;
      if (error instanceof PaymentProviderError) {
        throw new PaymentWebhookError(error.message, {
          status: error.retryable ? 503 : 502,
          retryable: error.retryable,
        });
      }
      throw error;
    }
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.rawBody));
  const payloadHash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

  if (depositBinding[0]) {
    const deposit = await ports.applyFinancingDeposit({
      providerKey: normalizedProviderKey,
      eventId: body.eventId,
      providerReference: body.providerReference,
      status: body.status,
      amount: body.amount,
      currency: body.currency,
      payloadHash,
    });
    await recordMetric("financing.deposit.webhook", {
      entityId: deposit?.depositPaymentId ?? body.providerReference,
      metadata: { providerKey: normalizedProviderKey, status: body.status },
    });
    return deposit ?? { ignored: true };
  }

  const rows = await sql.query<{ result: unknown }>(
    `select apply_payment_webhook($1,$2,$3,$4,$5,$6,$7,$8,$9) as result`,
    [
      normalizedProviderKey,
      body.eventId,
      body.eventType,
      body.providerReference,
      body.status,
      body.amount,
      body.currency,
      payloadHash,
      body.providerRefundId ?? null,
    ],
  );
  const result = rows[0]?.result ?? null;
  if (result && typeof result === "object") {
    if ("rejected" in result && result.rejected === true) {
      throw new PaymentWebhookError("Payment webhook rejected", { status: 400, retryable: false });
    }
    if ("retryable" in result && result.retryable === true) {
      throw new PaymentWebhookError("Payment reference is not bound yet", {
        status: 503,
        retryable: true,
      });
    }
  }
  await recordMetric("payment.webhook.processed", {
    entityId: body.providerReference,
    metadata: {
      providerKey: normalizedProviderKey,
      eventType: body.eventType,
      status: body.status,
    },
  });
  return result;
}

export async function completePreviewPaymentServer(input: { paymentId: string; userId: string }) {
  if (
    getElemarketEnvironment() !== "development" ||
    process.env.ELEMARKET_ENABLE_PREVIEW_SETTLEMENT !== "1"
  )
    throw new Error("Preview settlement is disabled");
  const owned = await requireCustomerPayment(input.paymentId, input.userId);
  if (!owned.provider_key?.toLowerCase().startsWith("preview"))
    throw new Error("Only explicit preview providers can simulate settlement");
  const sql = await getSql();
  const attempts = await sql.query<{
    id: string;
    provider_reference: string | null;
    provider_key: string;
    amount: string;
    currency: string;
  }>(
    `select id, provider_reference, provider_key, amount::text as amount, currency
       from payment_attempts
      where payment_id = $1
      order by attempt_no desc
      limit 1`,
    [owned.id],
  );
  const attempt = attempts[0];
  if (!attempt?.provider_reference) throw new Error("Payment has not been started");
  if (
    attempt.provider_key !== owned.provider_key ||
    !attempt.provider_key.toLowerCase().startsWith("preview")
  )
    throw new Error("Payment attempt is not bound to the preview provider");
  const eventId = `preview_${attempt.id}_${Date.now()}`;
  const raw = JSON.stringify({ paymentId: owned.id, attemptId: attempt.id, eventId });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const payloadHash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const rows = await sql.query<{ result: unknown }>(
    `select apply_payment_webhook($1,$2,$3,$4,$5,$6,$7,$8,$9) as result`,
    [
      attempt.provider_key,
      eventId,
      "preview.charge.success",
      attempt.provider_reference,
      "completed",
      Number(attempt.amount),
      attempt.currency,
      payloadHash,
      null,
    ],
  );
  await recordMetric("payment.preview.completed", { userId: input.userId, entityId: owned.id });
  const result = rows[0]?.result;
  if (
    !result ||
    (typeof result === "object" &&
      (("rejected" in result && result.rejected) || ("retryable" in result && result.retryable)))
  )
    throw new Error("Preview payment confirmation was not persisted");
  return result;
}
