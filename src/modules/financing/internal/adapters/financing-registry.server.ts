import type { FinancingProviderAdapter } from "@/modules/financing/internal/adapters/financing";

// Deliberately empty until a concrete provider integration is installed and tested.
// Registry/composition knowledge is the only generic place allowed to know adapters.
const financingAdapters = new Map<string, FinancingProviderAdapter>();

export function getFinancingProviderAdapter(providerKey: string): FinancingProviderAdapter | null {
  return financingAdapters.get(providerKey) ?? null;
}

export function isFinancingIntegrationOperational(input: {
  providerKey: string;
  integrationMode: string | null | undefined;
  audience: "customer" | "merchant";
}): boolean {
  if (input.integrationMode === "manual_review" || input.integrationMode === "partner_handoff") return true;
  if (input.integrationMode !== "api") return false;
  const adapter = getFinancingProviderAdapter(input.providerKey);
  if (!adapter) return false;
  return input.audience === "customer" ? adapter.supportsCustomerApplications : adapter.supportsMerchantApplications;
}
