export type FinancingApplicationKind = "customer" | "merchant";

export type FinancingApplicationRequest = {
  applicationId: string;
  amount: number;
  currency: string;
  subjectId: string;
  returnUrl?: string | null;
};

export type FinancingApplicationResponse = {
  providerReference: string;
  status: "pending" | "approved" | "declined" | "review";
  redirectUrl?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * External financing capability boundary.
 * ELEMARKET never implements underwriting, pricing or credit approval here.
 * Concrete lender/BNPL protocol details belong in provider-specific adapters only.
 */
export interface FinancingProviderAdapter {
  readonly providerKey: string;
  readonly supportsCustomerApplications: boolean;
  readonly supportsMerchantApplications: boolean;
  startApplication(kind: FinancingApplicationKind, request: FinancingApplicationRequest): Promise<FinancingApplicationResponse>;
}
