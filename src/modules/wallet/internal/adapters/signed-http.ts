import { z } from "zod";
import {
  configuredPayoutFee,
  PayoutProviderError,
  type PayoutCommand,
  type PayoutDestinationInput,
  type PayoutDriver,
  type PayoutRail,
  type PayoutState,
  type PayoutWebhookNotice,
  type RegisteredPayoutDestination,
} from "./payout";

/**
 * Generic signed-HTTP payout driver. Connect any provider by pointing it at the
 * provider's API (if it speaks this contract) or at a small bridge that maps
 * this contract onto the provider's own API. Contract: docs/merchant-wallet.md.
 *
 * Every request carries x-elemarket-signature: t=<unix>,v1=<hex HMAC-SHA256 of
 * "<t>.<METHOD>.<path>.<body>"> so the receiver can authenticate the wallet.
 */
export type HttpTransport = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

const stateSchema = z.object({
  providerReference: z.string().min(1).max(256),
  status: z.enum(["processing", "paid", "failed"]),
  amount: z.string().regex(/^\d{1,9}\.\d{2}$/).optional(),
  currency: z.literal("GHS").optional(),
  failureReason: z.string().max(500).optional(),
});
const destinationSchema = z.object({
  destinationRef: z.string().min(1).max(256),
  resolvedAccountName: z.string().max(160).nullable().optional(),
  verified: z.boolean(),
});

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class SignedHttpPayoutDriver implements PayoutDriver {
  readonly supportsIdempotentPayouts = true;
  readonly webhookSignatureHeaders = ["x-elemarket-signature"] as const;
  private readonly base: URL;
  constructor(
    readonly key: string,
    endpoint: string,
    private readonly secret: string,
    private readonly transport: HttpTransport,
    private readonly options: { quoteFeesRemotely?: boolean; env?: Record<string, string | undefined> } = {},
  ) {
    if (secret.length < 32) throw new Error("Payout driver secret must be at least 32 characters");
    this.base = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    if (this.base.protocol !== "https:") throw new Error("Payout endpoint must use HTTPS");
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<Response> {
    const url = new URL(path.replace(/^\//, ""), this.base);
    const raw = body === undefined ? "" : JSON.stringify(body);
    const t = Math.floor(Date.now() / 1000);
    const signature = await hmacHex(this.secret, `${t}.${method}.${url.pathname}.${raw}`);
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-elemarket-signature": `t=${t},v1=${signature}`,
      ...(raw ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    };
    try {
      return await this.transport(url.toString(), { method, headers, body: raw || undefined, signal: AbortSignal.timeout(15_000) });
    } catch {
      // Network failure: the provider may or may not have received the command.
      throw new PayoutProviderError("Payout provider unreachable", false);
    }
  }

  private async json(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length > 256 * 1024) throw new PayoutProviderError("Payout provider response too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new PayoutProviderError("Invalid payout provider response", false, response.status);
    }
  }

  async quoteFee(input: { amount: string; currency: "GHS"; rail: PayoutRail }): Promise<string> {
    if (!this.options.quoteFeesRemotely) return configuredPayoutFee(input.amount, this.options.env);
    const response = await this.call("POST", "fees", input);
    if (!response.ok) throw new PayoutProviderError("Payout fee quote failed", false, response.status);
    const parsed = z.object({ fee: z.string().regex(/^\d{1,9}\.\d{2}$/) }).safeParse(await this.json(response));
    if (!parsed.success) throw new PayoutProviderError("Invalid payout fee quote");
    return parsed.data.fee;
  }

  async registerDestination(input: PayoutDestinationInput): Promise<RegisteredPayoutDestination> {
    const response = await this.call("POST", "destinations", input);
    if (!response.ok) throw new PayoutProviderError("Payout destination could not be registered", response.status < 500, response.status);
    const parsed = destinationSchema.safeParse(await this.json(response));
    if (!parsed.success) throw new PayoutProviderError("Invalid payout destination response");
    return { ...parsed.data, resolvedAccountName: parsed.data.resolvedAccountName ?? null };
  }

  async createPayout(command: PayoutCommand): Promise<PayoutState> {
    const response = await this.call("POST", "payouts", {
      payoutId: command.payoutId,
      amount: command.amount,
      currency: command.currency,
      rail: command.rail,
      destinationRef: command.destinationRef,
      narration: command.narration,
    }, command.idempotencyKey);
    if (response.status === 409) {
      // Already accepted under this idempotency key: read it back.
      const existing = await this.getPayout(command.payoutId, null);
      if (existing) return existing;
      throw new PayoutProviderError("Payout conflict without a readable payout");
    }
    // 400/422: validation refusal, the transfer was definitely not created.
    if (response.status === 400 || response.status === 422)
      throw new PayoutProviderError("Payout provider rejected the transfer", true, response.status);
    if (!response.ok) throw new PayoutProviderError("Payout provider error", false, response.status);
    const parsed = stateSchema.safeParse(await this.json(response));
    if (!parsed.success) throw new PayoutProviderError("Invalid payout provider response");
    return parsed.data;
  }

  async getPayout(payoutId: string, _providerReference: string | null): Promise<PayoutState | null> {
    const response = await this.call("GET", `payouts/${encodeURIComponent(payoutId)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new PayoutProviderError("Payout status lookup failed", false, response.status);
    const parsed = stateSchema.safeParse(await this.json(response));
    if (!parsed.success) throw new PayoutProviderError("Invalid payout status response");
    return parsed.data;
  }

  async verifyWebhook(rawBody: string, signature: string | null): Promise<boolean> {
    if (!signature) return false;
    const parts = Object.fromEntries(signature.split(",").map((p) => p.trim().split("=", 2))) as Record<string, string | undefined>;
    const t = Number(parts.t);
    const v1 = parts.v1?.toLowerCase();
    if (!Number.isSafeInteger(t) || !v1 || !/^[a-f0-9]{64}$/.test(v1)) return false;
    if (Math.abs(Date.now() / 1000 - t) > 300) return false;
    return timingSafeHexEqual(await hmacHex(this.secret, `${t}.${rawBody}`), v1);
  }

  async parseWebhook(rawBody: string): Promise<PayoutWebhookNotice | null> {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new Error("Invalid payout webhook payload");
    }
    const parsed = z.object({
      payoutId: z.string().regex(/^wpo_[a-f0-9]{32}$/),
      providerReference: z.string().min(1).max(256).nullable().optional(),
    }).safeParse(body);
    if (!parsed.success) throw new Error("Invalid payout webhook payload");
    return { payoutId: parsed.data.payoutId, providerReference: parsed.data.providerReference ?? null };
  }
}
