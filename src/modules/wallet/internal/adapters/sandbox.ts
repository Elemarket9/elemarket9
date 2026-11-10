import {
  configuredPayoutFee,
  maskAccount,
  type PayoutCommand,
  type PayoutDestinationInput,
  type PayoutDriver,
  type PayoutRail,
  type PayoutCapabilities,
  type PayoutState,
  type ProviderPayoutRecord,
  type RegisteredPayoutDestination,
} from "./payout";

/**
 * Development-only payout sandbox. No money moves and no network is used.
 * A transfer is "processing" when created and "paid" on its first read-back.
 * Destinations whose account number ends in 0000 always fail, for testing.
 * The registry refuses this driver outside an isolated development opt-in.
 */
type SandboxRecord = PayoutState & { reads: number; payoutId: string };
const store = ((globalThis as { __elemarketPayoutSandbox__?: Map<string, SandboxRecord> }).__elemarketPayoutSandbox__ ??=
  new Map<string, SandboxRecord>());

export class SandboxPayoutDriver implements PayoutDriver {
  readonly key = "sandbox";
  readonly capabilities: PayoutCapabilities = Object.freeze({
    idempotentInitiation: true, statusLookup: true, webhooks: false,
    reconciliationListing: true, destinationValidation: true, feeQuote: false,
  });
  async quoteFee(input: { amount: string; currency: "GHS"; rail: PayoutRail }): Promise<string> {
    return configuredPayoutFee(input.amount);
  }
  async registerDestination(input: PayoutDestinationInput): Promise<RegisteredPayoutDestination> {
    const fails = input.accountNumber.replace(/\D/g, "").endsWith("0000");
    return {
      destinationRef: `sandbox_${fails ? "fail" : "ok"}_${maskAccount(input.accountNumber).replace(/\D/g, "")}_${crypto.randomUUID().slice(0, 8)}`,
      resolvedAccountName: input.accountName,
      verified: true,
    };
  }
  async createPayout(command: PayoutCommand): Promise<PayoutState> {
    const existing = store.get(command.idempotencyKey);
    if (existing) return existing;
    const record: SandboxRecord = {
      providerReference: `sbx_${command.payoutId.slice(4, 20)}`,
      status: "processing",
      amount: command.amount,
      currency: command.currency,
      reads: 0,
      payoutId: command.payoutId,
      failureReason: command.destinationRef.startsWith("sandbox_fail") ? "Sandbox: destination rejected the transfer" : undefined,
    };
    store.set(command.idempotencyKey, record);
    return { ...record };
  }
  async getPayout(payoutId: string): Promise<PayoutState | null> {
    const record = store.get(payoutId);
    if (!record) return null;
    record.reads += 1;
    if (record.status === "processing") record.status = record.failureReason ? "failed" : "paid";
    const { reads: _reads, payoutId: _payoutId, ...state } = record;
    return state;
  }
  async listPayouts(): Promise<ProviderPayoutRecord[]> {
    return [...store.values()].map((r) => ({
      payoutId: r.payoutId, providerReference: r.providerReference, status: r.status,
      amount: r.amount ?? "0.00", currency: r.currency ?? "GHS",
    }));
  }
}
