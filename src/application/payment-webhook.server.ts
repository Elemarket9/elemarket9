import { handlePaymentWebhook as processPaymentWebhook } from "@/modules/payments/public/payment.server";
import { applyFinancingDepositWebhook } from "@/modules/financing/public/financing-deposit.server";

/** Composition root: the payment domain has no dependency on financing. */
export function handlePaymentWebhook(input: Parameters<typeof processPaymentWebhook>[0]) {
  return processPaymentWebhook(input, { applyFinancingDeposit: applyFinancingDepositWebhook });
}
