import type { PaymentProviderAdapter } from "../payment";

/** Literal imports keep configured bundled drivers in the production build. */
export async function loadBundledPaymentDriver(
  specifier: string,
): Promise<{
  createPaymentAdapter: (args: { providerKey: string }) => PaymentProviderAdapter;
} | null> {
  if (specifier === "builtin:paystack") return import("./paystack");
  return null;
}
