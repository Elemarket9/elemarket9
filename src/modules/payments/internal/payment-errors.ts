export class PaymentWebhookError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; publicMessage?: string; retryable?: boolean }) {
    super(message);
    this.name = "PaymentWebhookError";
    this.status = options.status;
    this.publicMessage = options.publicMessage ?? (options.status === 401 ? "Unauthorized" : options.status === 413 ? "Payload too large" : options.status >= 500 ? "Webhook temporarily unavailable" : "Webhook rejected");
    this.retryable = options.retryable ?? options.status >= 500;
  }
}

export class PaymentProviderError extends Error {
  readonly retryable: boolean;
  readonly providerStatus: number;

  constructor(message: string, providerStatus: number, retryable = providerStatus === 429 || providerStatus >= 500) {
    super(message);
    this.name = "PaymentProviderError";
    this.providerStatus = providerStatus;
    this.retryable = retryable;
  }
}
