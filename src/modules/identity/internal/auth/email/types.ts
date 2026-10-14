export type TransactionalEmailKind =
  | "email_otp"
  | "verification"
  | "password_reset"
  | "security";

export type EmailSendInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind: TransactionalEmailKind;
  idempotencyKey?: string;
};

export type EmailSendResult = {
  accepted: boolean;
  providerMessage?: string;
  providerId?: string;
  retryAfter?: number;
};

export interface EmailProviderAdapter {
  readonly key: string;
  send(input: EmailSendInput): Promise<EmailSendResult>;
}
