export type OtpPurpose =
  | "signup"
  | "login"
  | "phone_verification"
  | "password_reset"
  | "transactional"
  | "delivery_handover";

export type OtpProviderCode = "accepted" | "verified" | "invalid" | "expired" | "rejected";

export type OtpGenerateInput = {
  number: string;
  expiryMinutes: number;
  length: number;
  message: string;
  senderId?: string;
  purpose?: OtpPurpose;
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
