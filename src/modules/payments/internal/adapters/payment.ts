import { z } from "zod";
import { fetchPinnedPublicHttps } from "@/lib/security/pinned-https.server";
import { PaymentProviderError } from "@/modules/payments/internal/payment-errors";
export type PaymentAdapterInput = {
  paymentId: string;
  attemptId: string;
  amount: string;
  currency: string;
  method: string;
  customerReference?: string;
  customerEmail?: string;
  merchantSubaccount?: string;
  idempotencyKey?: string;
  callbackUrl?: string;
};

export type PaymentRefundResult = {
  providerRefundId: string | null;
  status: "processing" | "processed" | "needs_attention";
  metadata?: Record<string, unknown>;
};

export type PaymentAdapterResult = {
  providerReference: string;
  status: "initiated" | "authorized" | "completed" | "failed";
  checkoutUrl?: string;
  metadata?: Record<string, unknown>;
};

export interface PaymentProviderAdapter {
  /** Provider must guarantee duplicate-safe initialization for the supplied idempotency key. */
  readonly supportsIdempotentInitialization: boolean;
  /** True only when the adapter can route a payment directly to a supplied provider/subaccount reference. */
  readonly supportsDirectSubaccountSettlement: boolean;
  /** Provider-specific webhook signature headers belong to the adapter boundary. */
  readonly webhookSignatureHeaders?: readonly string[];
  createPayment(input: PaymentAdapterInput): Promise<PaymentAdapterResult>;
  verifyWebhook?(rawBody: string, signature: string | null): Promise<boolean>;
  parseWebhook?(rawBody: string): Promise<ParsedPaymentWebhook | null>;
  verifyTransaction?(reference: string): Promise<VerifiedPayment>;
  /** Enable only after provider contract and concurrency tests prove duplicate safety. */
  readonly supportsIdempotentRefunds?: boolean;
  /** Must identify the exact attempt, verify amount/currency/reference, and never create a refund. */
  reconcileRefund?(input: {
    providerReference: string;
    providerRefundId: string | null;
    amount: string;
    currency: string;
    idempotencyKey: string;
  }): Promise<PaymentRefundResult | { status: "not_found" }>;
  refundPayment?(input: {
    providerReference: string;
    amount: string;
    currency: string;
    customerNote?: string;
    merchantNote?: string;
    idempotencyKey?: string;
  }): Promise<PaymentRefundResult>;
}

export type CanonicalPaymentEvent =
  | "payment.authorized" | "payment.completed" | "payment.failed"
  | "refund.pending" | "refund.processing" | "refund.needs-attention"
  | "refund.failed" | "refund.processed";

export type ParsedPaymentWebhook = {
  eventId: string;
  eventType: CanonicalPaymentEvent;
  providerReference: string;
  status: "authorized" | "completed" | "failed" | "refunded";
  amount: number;
  currency: string;
  providerRefundId?: string;
};

export type VerifiedPayment = {
  status: string;
  reference: string;
  amount: number;
  currency: string;
  providerRefundId?: string;
};

async function genericVerify(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;
  const parts = Object.fromEntries(
    signature.split(",").map((part) => part.split("=", 2)),
  ) as Record<string, string | undefined>;
  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (
    !Number.isSafeInteger(timestamp) ||
    !provided ||
    Math.abs(Date.now() / 1000 - timestamp) > 300 ||
    !/^[a-f0-9]{64}$/i.test(provided)
  )
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)),
  );
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(provided.slice(i * 2, i * 2 + 2), 16);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= expected[i] ^ bytes[i];
  return diff === 0;
}

export class JsonHttpPaymentAdapter implements PaymentProviderAdapter {
  readonly supportsDirectSubaccountSettlement = false;
  readonly webhookSignatureHeaders = ["x-elemarket-signature"] as const;
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
    readonly supportsIdempotentInitialization: boolean,
  ) {}
  async verifyWebhook(rawBody: string, signature: string | null): Promise<boolean> {
    return genericVerify(rawBody, signature, this.secret);
  }
  async parseWebhook(rawBody: string): Promise<ParsedPaymentWebhook | null> {
    const schema = z.object({
      eventId: z.string().min(1).max(256),
      eventType: z.enum([
        "payment.authorized", "payment.completed", "payment.failed",
        "refund.pending", "refund.processing", "refund.needs-attention",
        "refund.failed", "refund.processed",
      ]),
      providerReference: z.string().min(1).max(256),
      status: z.enum(["authorized", "completed", "failed", "refunded"]),
      amount: z.number().finite().positive(),
      currency: z.string().regex(/^[A-Z]{3}$/),
    });
    const parsed = schema.safeParse(JSON.parse(rawBody));
    if (!parsed.success) throw new Error("Invalid provider webhook payload");
    const validStatus: Record<CanonicalPaymentEvent, ParsedPaymentWebhook["status"]> = {
      "payment.authorized": "authorized", "payment.completed": "completed", "payment.failed": "failed",
      "refund.pending": "completed", "refund.processing": "completed",
      "refund.needs-attention": "completed", "refund.failed": "completed",
      "refund.processed": "refunded",
    };
    if (parsed.data.status !== validStatus[parsed.data.eventType])
      throw new Error("Provider webhook event and status disagree");
    return parsed.data;
  }
  async verifyTransaction(reference: string): Promise<VerifiedPayment> {
    const response = await fetchPinnedPublicHttps(
      `${this.endpoint.replace(/\/$/, "")}/verify/${encodeURIComponent(reference)}`,
      { headers: { authorization: `Bearer ${this.secret}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok)
      throw new PaymentProviderError(
        "Payment provider transaction verification failed",
        response.status,
      );
    const parsed = z
      .object({
        status: z.string(),
        reference: z.string(),
        amount: z.number().finite().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .safeParse(await response.json());
    if (!parsed.success)
      throw new Error("Payment provider verification response failed validation");
    return parsed.data;
  }
  async createPayment(input: PaymentAdapterInput): Promise<PaymentAdapterResult> {
    const response = await fetchPinnedPublicHttps(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.secret}`,
        ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Payment provider returned HTTP ${response.status}`);
    const schema = z.object({
      providerReference: z.string().min(1).max(256),
      status: z.enum(["initiated", "authorized", "completed", "failed"]),
      checkoutUrl: z.string().url().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    });
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Payment provider response failed validation");
    return parsed.data;
  }
}

export class PreviewPaymentAdapter implements PaymentProviderAdapter {
  readonly supportsIdempotentInitialization = true;
  readonly supportsDirectSubaccountSettlement = true;
  async createPayment(input: PaymentAdapterInput): Promise<PaymentAdapterResult> {
    const financingDeposit = input.customerReference?.startsWith("financing_deposit:");
    return {
      providerReference: input.attemptId,
      status: "initiated",
      checkoutUrl: financingDeposit
        ? `/financing/deposit-preview?depositPaymentId=${encodeURIComponent(input.paymentId)}`
        : `/payment/preview?paymentId=${encodeURIComponent(input.paymentId)}`,
      metadata: {
        preview: true,
        purpose: financingDeposit ? "financing_deposit" : "marketplace_order",
      },
    };
  }
}
