export type KybDecision = "VERIFIED" | "REVIEW" | "NOT_FOUND";

export interface KybVerifyInput {
  businessName: string;
  registrationNumber?: string;
  country: string;
}

export interface KybResult {
  decision: KybDecision;
  registered: boolean;
  provider: string;
  providerReference?: string;
  legalName?: string;
  registrationNumber?: string;
  status?: string;
  matchConfidence?: number;
  dataConfidence?: number;
  sanctionsClear?: boolean;
  evidence: unknown;
}

export interface KYBProvider {
  verifyBusiness(input: KybVerifyInput): Promise<KybResult>;
}
