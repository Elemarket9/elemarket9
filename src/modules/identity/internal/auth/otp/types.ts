export type OtpPurpose =
  | "signup"
  | "login"
  | "phone_verification"
  | "password_reset"
  | "transactional";

export type OtpProviderCode = "accepted" | "verified" | "invalid" | "expired" | "rejected";

export type OtpGenerateInput = {
  number: string;
  expiryMinutes: number;
  length: number;
  message: string;
  senderId?: string;
};

export type OtpGenerateResult = {
  code: OtpProviderCode;
  providerMessage?: string;
};

export type OtpVerifyResult = {
  code: OtpProviderCode;
  providerMessage?: string;
};

export interface OtpProviderAdapter {
  readonly key: string;
  send(input: OtpGenerateInput): Promise<OtpGenerateResult>;
  verify(input: { number: string; code: string }): Promise<OtpVerifyResult>;
}
