import { createServerFn } from "@tanstack/react-start";

/**
 * Public, read-only: active marketplace promotions an administrator chose to
 * list on /deals. Shows only customer-facing terms — never budgets or usage.
 */
export const listPublicMarketplaceDeals = createServerFn({ method: "GET" }).handler(async () => {
  const { enforceRateLimit } = await import("@/lib/security/rate-limit.server");
  await enforceRateLimit("public-deals", { windowSeconds: 60, maxRequests: 120 });
  const { listPublicDeals } = await import("../../admin-promotions.server");
  return listPublicDeals();
});
