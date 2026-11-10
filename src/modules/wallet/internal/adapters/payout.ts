/**
 * Provider-neutral payout driver contract.
 *
 * The merchant wallet decides WHEN and HOW MUCH to pay. A driver only turns the
 * wallet's command into a call to whichever payout provider is configured.
 * Drivers never decide balances, and the wallet never trusts a driver's word
 * about a final outcome without reading it back with getPayout().
 */
export type PayoutRail = "mobile_money" | "bank";

export type PayoutDestinationInput = {
  rail: PayoutRail;
  /** Mobile number (E.164, +233…) or bank account number. Never stored. */
  accountNumber: string;
  /** Bank or mobile network code expected by the provider. */
  institutionCode: string;
  accountName: string;
};

export type RegisteredPayoutDestination = {
  /** Opaque provider token (recipient code). The only thing ELEMARKET stores. */
  destinationRef: string;
  /** Name the provider resolved for the account, if it resolves names. */
  resolvedAccountName: string | null;
  /** True only when the provider confirmed the account exists. */
  verified: boolean;
};

export type PayoutCommand = {
  payoutId: string;
  /** Equal to payoutId. Retries must never create a second transfer. */
  idempotencyKey: string;
  /** Net amount sent to the merchant, major units with 2 decimals ("125.00"). */
  amount: string;
  currency: "GHS";
  rail: PayoutRail;
  destinationRef: string;
  narration: string;
};

export type PayoutState = {
  providerReference: string;
  status: "processing" | "paid" | "failed";
  amount?: string;
  currency?: string;
  failureReason?: string;
};

export type PayoutWebhookNotice = { payoutId: string; providerReference: string | null };

export interface PayoutDriver {
  readonly key: string;
  /** Must be true: the provider de-duplicates on idempotencyKey. */
  readonly supportsIdempotentPayouts: boolean;
  readonly webhookSignatureHeaders?: readonly string[];
  /** Transfer fee in GHS for this amount and rail. The merchant pays it. */
  quoteFee(input: { amount: string; currency: "GHS"; rail: PayoutRail }): Promise<string>;
  registerDestination(input: PayoutDestinationInput): Promise<RegisteredPayoutDestination>;
  createPayout(command: PayoutCommand): Promise<PayoutState>;
  /** Authoritative read-back. null means the provider has no such payout. */
  getPayout(payoutId: string, providerReference: string | null): Promise<PayoutState | null>;
  verifyWebhook?(rawBody: string, signature: string | null): Promise<boolean>;
  /** Identify which payout a notification concerns. Status is re-read via getPayout. */
  parseWebhook?(rawBody: string): Promise<PayoutWebhookNotice | null>;
}

export class PayoutProviderError extends Error {
  constructor(
    message: string,
    /** True when the provider definitely did NOT accept the transfer. */
    readonly rejected = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PayoutProviderError";
  }
}

/** Deployment-configured fee: ELEMARKET_PAYOUT_FEE_FLAT (GHS) + ELEMARKET_PAYOUT_FEE_BPS. */
export function configuredPayoutFee(amount: string, env: Record<string, string | undefined> = process.env): string {
  const pesewas = toPesewas(amount);
  const flat = toPesewas(env.ELEMARKET_PAYOUT_FEE_FLAT?.trim() || "0");
  const bpsRaw = env.ELEMARKET_PAYOUT_FEE_BPS?.trim() || "0";
  if (!/^\d{1,4}$/.test(bpsRaw) || Number(bpsRaw) > 1000) throw new Error("Invalid ELEMARKET_PAYOUT_FEE_BPS");
  const fee = flat + Math.ceil((pesewas * Number(bpsRaw)) / 10_000);
  return fromPesewas(fee);
}

export function toPesewas(amount: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(amount).trim());
  if (!match) throw new Error("Invalid money amount");
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function fromPesewas(pesewas: number): string {
  if (!Number.isSafeInteger(pesewas) || pesewas < 0) throw new Error("Invalid money amount");
  return `${Math.floor(pesewas / 100)}.${String(pesewas % 100).padStart(2, "0")}`;
}

export function maskAccount(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "••••";
}
