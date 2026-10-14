/**
 * Marketplace sales/refund read model.
 *
 * ELEMARKET does not custody or settle merchant funds. The configured payment
 * provider owns collection, settlement and refunds. This contract exposes
 * marketplace order economics plus provider refund operations only.
 */
export type MerchantFinanceBalance = {
  currency: "GHS";
  totalSales: string;
  platformCommission: string;
  merchantOrderValue: string;
  refundExceptionAmount: string;
  providerHeldEligible: string;
  providerRequestable: string;
  pendingReleaseRequests: string;
  providerWithdrawalEligibility: {
    eligibleAmount: string | number;
    eligibleOrders: number;
    activeDisputes: number;
    currency: string;
    custodyBoundary: string;
    withdrawalAction: string;
  };
};

export type MerchantFinanceRefundRequest = {
  id: string;
  orderId: string;
  amount: string;
  status: string;
  reason: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type MerchantFinanceSnapshot = {
  balance: MerchantFinanceBalance;
  refundRequests: MerchantFinanceRefundRequest[];
};

export interface MerchantFinanceProvider {
  getSnapshot(merchantId: string): Promise<MerchantFinanceSnapshot>;
}
