import type { EmailProviderAdapter, EmailSendInput, EmailSendResult } from "../types";

const RESEND_API_URL = "https://api.resend.com/emails";

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is not configured`);
  return value;
}

function optionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

export class ResendEmailAdapter implements EmailProviderAdapter {
  readonly key = "resend";

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const apiKey = requiredEnv("RESEND_API_KEY");
    const from = requiredEnv("RESEND_FROM_EMAIL");
    const replyTo = optionalEnv("RESEND_REPLY_TO");
    const body = JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    });

    // A timed-out email request may already have been accepted. Automatic
    // retries are safe only when the caller supplied a stable idempotency key.
    const maxAttempts = input.idempotencyKey ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await fetch(RESEND_API_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
          },
          body,
          redirect: "error", signal: AbortSignal.timeout(10_000),
        });

        const payload = await response.json().catch(() => null) as
          | { id?: string; message?: string; name?: string }
          | null;

        if (response.ok) {
          return {
            accepted: true,
            providerId: payload?.id,
            providerMessage: payload?.message,
          };
        }

        const retryAfter = response.headers.get("retry-after");
        const retryable = response.status === 429 || response.status >= 500;
        const delay = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Math.min(10_000, Math.max(250, Math.ceil(Number(retryAfter) * 1000)))
          : Math.min(5_000, 500 * 2 ** attempt);
        const detail = payload?.message || payload?.name || `HTTP ${response.status}`;
        if (!retryable || attempt === maxAttempts - 1) {
          const error = new Error(`Resend email request failed (${detail})`);
          (error as Error & { status?: number; retryAfter?: number }).status = response.status;
          if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
            (error as Error & { status?: number; retryAfter?: number }).retryAfter = Math.max(1, Math.ceil(Number(retryAfter)));
          }
          throw error;
        }
        const retryError = new Error("Email provider temporarily unavailable") as Error & { status?: number; retryAfter?: number };
        retryError.status = response.status;
        retryError.retryAfter = delay;
        throw retryError;
      } catch (error) {
        lastError = error;
        const status = (error as Error & { status?: number }).status;
        if ((status !== 429 && (!status || status < 500)) || attempt === maxAttempts - 1) throw error;
        const delay = (error as Error & { retryAfter?: number }).retryAfter;
        await new Promise((resolve) => setTimeout(resolve, delay ?? Math.min(5_000, 500 * 2 ** attempt)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Resend email request failed");
  }
}

let singleton: ResendEmailAdapter | undefined;

export function getResendEmailAdapter(): ResendEmailAdapter {
  singleton ??= new ResendEmailAdapter();
  return singleton;
}
