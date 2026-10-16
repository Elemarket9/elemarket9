import { z } from "zod";
import { readResponseBodyWithLimit } from "@/lib/security/body.server";
import type {
  PaymentAdapterInput,
  PaymentAdapterResult,
  PaymentProviderAdapter,
  ParsedPaymentWebhook,
  VerifiedPayment,
  PaymentRefundResult,
} from "../payment";
import { PaymentProviderError } from "@/modules/payments/internal/payment-errors";

async function readProviderJson(response: Response): Promise<unknown> {
  const body = await readResponseBodyWithLimit(response, 512 * 1024);
  try {
    return JSON.parse(body);
  } catch {
    // JSON parser errors may quote provider response contents into application logs.
    throw new Error("Invalid payment provider JSON response");
  }
}

const initializeResponse = z.object({
  status: z.boolean(),
  data: z
    .object({
      reference: z.string().min(1).max(256),
      authorization_url: z.string().url(),
      access_code: z.string().max(256).optional(),
    })
    .nullable()
    .optional(),
});

const verifyResponse = z.object({
  status: z.boolean(),
  data: z
    .object({
      status: z.string().min(1).max(64),
      reference: z.string().min(1).max(256),
      amount: z.number().int().positive().safe(),
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .nullable()
    .optional(),
});

const refundResponse = z.object({
  status: z.boolean(),
  data: z
    .object({
      id: z.union([z.string(), z.number()]).optional(),
      status: z.string().min(1).max(64),
      amount: z.number().int().positive().safe(),
      expected_at: z.string().optional().nullable(),
      reason: z.string().max(500).optional().nullable(),
      transaction: z
        .object({ reference: z.string().max(256).optional().nullable() })
        .optional()
        .nullable(),
    })
    .nullable()
    .optional(),
});

const webhookSchema = z.object({
  event: z.string().min(1).max(128),
  data: z.record(z.string(), z.unknown()).default({}),
});

function asString(value: unknown, max = 256): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function asProviderId(value: unknown): string | null {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return asString(value);
}

export class PaystackPaymentAdapter implements PaymentProviderAdapter {
  // A request header is not evidence of refund idempotency. Automatic retries stay disabled.
  readonly supportsIdempotentRefunds = false;
  // A unique provider reference prevents a duplicate charge, but the provider
  // does not document replaying the same checkout response after a timeout.
  // Fail closed until safe reference-based initialization recovery is verified.
  readonly supportsIdempotentInitialization = false;
  readonly supportsDirectSubaccountSettlement = true;
  readonly webhookSignatureHeaders = ["x-paystack-signature"] as const;
  constructor(
    private readonly secret: string,
    private readonly baseUrl = "https://api.paystack.co",
  ) {}
  async createPayment(input: PaymentAdapterInput): Promise<PaymentAdapterResult> {
    if (!input.customerEmail) throw new Error("Provider requires a customer email");
    if (input.currency !== "GHS")
      throw new Error("Configured provider currently supports GHS only");
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.amount.trim());
    if (!m) throw new Error("Invalid payment amount");
    const amountMinor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
      throw new Error("Invalid payment amount");
    const reference = input.attemptId.replace(/[^A-Za-z0-9\-.=]/g, "").slice(0, 100);
    const body: Record<string, unknown> = {
      email: input.customerEmail,
      amount: String(amountMinor),
      currency: input.currency,
      reference,
      metadata: JSON.stringify({ paymentId: input.paymentId, attemptId: input.attemptId }),
    };
    if (input.merchantSubaccount) body.subaccount = input.merchantSubaccount;
    if (input.callbackUrl) body.callback_url = input.callbackUrl;
    const response = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.secret}`,
        ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = initializeResponse.safeParse(await readProviderJson(response));
    if (
      !response.ok ||
      !parsed.success ||
      parsed.data.status !== true ||
      !parsed.data.data?.reference ||
      parsed.data.data.reference !== reference ||
      !parsed.data.data.authorization_url
    )
      throw new Error(`Provider transaction initialization failed (HTTP ${response.status})`);
    return {
      providerReference: parsed.data.data.reference,
      status: "initiated",
      checkoutUrl: parsed.data.data.authorization_url,
      metadata: { accessCode: parsed.data.data.access_code },
    };
  }
  async verifyWebhook(rawBody: string, signature: string | null): Promise<boolean> {
    if (!signature) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.secret),
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
    );
    const provided = signature.trim().toLowerCase();
    if (!/^[a-f0-9]{128}$/.test(provided)) return false;
    const bytes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bytes[i] = Number.parseInt(provided.slice(i * 2, i * 2 + 2), 16);
    if (expected.length !== bytes.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ bytes[i];
    return diff === 0;
  }
  async parseWebhook(rawBody: string): Promise<ParsedPaymentWebhook | null> {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      throw new Error("Invalid provider webhook payload");
    }
    const parsed = webhookSchema.safeParse(parsedBody);
    if (!parsed.success) throw new Error("Invalid provider webhook payload");
    const event = parsed.data.event;
    const data = parsed.data.data;
    const canonical: Record<string, { eventType: ParsedPaymentWebhook["eventType"]; status: ParsedPaymentWebhook["status"] }> = {
      "charge.success": { eventType: "payment.completed", status: "completed" },
      "charge.failed": { eventType: "payment.failed", status: "failed" },
      "refund.pending": { eventType: "refund.pending", status: "completed" },
      "refund.processing": { eventType: "refund.processing", status: "completed" },
      "refund.needs-attention": { eventType: "refund.needs-attention", status: "completed" },
      "refund.failed": { eventType: "refund.failed", status: "completed" },
      "refund.processed": { eventType: "refund.processed", status: "refunded" },
    };
    const normalized = canonical[event];
    if (!normalized) return null;
    const isRefund = normalized.eventType.startsWith("refund.");
    const reference = asString(isRefund ? data.transaction_reference : data.reference);
    const providerEventId = asProviderId(
      isRefund ? (data.refund_reference ?? data.id ?? reference) : (data.id ?? reference),
    );
    const eventId = providerEventId && reference ? `${event}:${providerEventId}:${reference}` : "";
    if (!reference || !eventId) throw new Error("Invalid provider webhook payload");
    const amountMinor = typeof data.amount === "number" ? data.amount : Number(data.amount);
    const currency = asString(data.currency, 3) ?? "";
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || currency !== "GHS")
      throw new Error("Invalid provider transaction amount/currency");
    return {
      eventId,
      eventType: normalized.eventType,
      providerReference: reference,
      status: normalized.status,
      amount: amountMinor / 100,
      currency,
      providerRefundId: isRefund
        ? (asProviderId(data.id) ?? asString(data.refund_reference) ?? undefined)
        : undefined,
    };
  }
  async refundPayment(input: {
    providerReference: string;
    amount: string;
    currency: string;
    customerNote?: string;
    merchantNote?: string;
    idempotencyKey?: string;
  }): Promise<PaymentRefundResult> {
    if (input.currency !== "GHS")
      throw new Error("Configured provider currently supports GHS only");
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.amount.trim());
    if (!m) throw new Error("Invalid refund amount");
    const amountMinor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
      throw new Error("Invalid refund amount");
    const response = await fetch(`${this.baseUrl}/refund`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.secret}`,
        ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        transaction: input.providerReference,
        amount: String(amountMinor),
        currency: input.currency,
        customer_note: input.customerNote?.slice(0, 500),
        merchant_note: input.merchantNote?.slice(0, 500),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = refundResponse.safeParse(await readProviderJson(response));
    const data = parsed.success ? parsed.data.data : null;
    if (!response.ok || !parsed.success || parsed.data.status !== true || !data)
      throw new Error("Payment provider refund request failed");
    const providerAmount = data.amount;
    if (providerAmount !== amountMinor) throw new Error("Provider refund amount is invalid");
    const transactionReference = data.transaction?.reference ?? "";
    if (transactionReference && transactionReference !== input.providerReference)
      throw new Error("Provider refund transaction mismatch");
    const providerRefundId = data.id == null ? null : String(data.id);
    if (data.status === "processed")
      return {
        providerRefundId,
        status: "processed",
        metadata: { expectedAt: data.expected_at ?? null, amount: providerAmount },
      };
    if (data.status === "needs-attention")
      return {
        providerRefundId,
        status: "needs_attention",
        metadata: { reason: data.reason ?? null, amount: providerAmount },
      };
    if (!["pending", "processing"].includes(data.status)) {
      // A provider refusal/failure/unknown refund state cannot be represented
      // as a successful in-flight request; require operator reconciliation.
      return {
        providerRefundId,
        status: "needs_attention",
        metadata: { providerStatus: data.status, amount: providerAmount },
      };
    }
    return {
      providerRefundId,
      status: "processing",
      metadata: { expectedAt: data.expected_at ?? null, amount: providerAmount },
    };
  }

  async verifyTransaction(reference: string): Promise<VerifiedPayment> {
    const response = await fetch(
      `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { authorization: `Bearer ${this.secret}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new PaymentProviderError("Provider transaction verification failed", response.status);
    const parsed = verifyResponse.safeParse(await readProviderJson(response));
    if (!parsed.success || parsed.data.status !== true || !parsed.data.data)
      throw new PaymentProviderError(
        "Provider transaction verification failed",
        response.status,
        false,
      );
    return {
      status: parsed.data.data.status === "success" ? "completed" : parsed.data.data.status,
      reference: parsed.data.data.reference,
      amount: parsed.data.data.amount / 100,
      currency: parsed.data.data.currency,
    };
  }
}

/** Deployment adapter factory. The registry knows only the driver contract. */
export function createPaymentAdapter({
  providerKey,
}: {
  providerKey: string;
}): PaystackPaymentAdapter {
  const envKey = `ELEMARKET_PAYMENT_${providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_SECRET`;
  const secret = process.env[envKey]?.trim();
  if (!secret) throw new Error("Payment provider credentials are not configured");
  return new PaystackPaymentAdapter(secret);
}
