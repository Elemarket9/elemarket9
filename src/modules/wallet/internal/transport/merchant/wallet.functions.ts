import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";

const merchantId = z.string().trim().min(1).max(128);
const amount = z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, "Enter an amount like 250 or 250.50");

/** Any active merchant account (or an admin) may view. */
async function authorizeView(merchant: string, userId: string) {
  const { requireMerchantAccessForUserId } = await import("@/modules/identity/public/auth/authorization.server");
  await requireMerchantAccessForUserId(merchant, userId);
}

/** Moving money or changing where it goes: the merchant owner only, freshly signed in. */
async function authorizeOwnerMoneyAction(merchant: string, userId: string, bucket: string) {
  const [{ requireMerchantAccessForUserId }, { requireFreshSession }, { enforceRateLimit }] = await Promise.all([
    import("@/modules/identity/public/auth/authorization.server"),
    import("@/modules/identity/public/auth/verify.server"),
    import("@/lib/security/rate-limit.server"),
  ]);
  const principal = await requireMerchantAccessForUserId(merchant, userId);
  if (principal.role === "admin") throw new Error("Only the merchant can move wallet funds");
  await requireFreshSession();
  await enforceRateLimit(bucket, { windowSeconds: 600, maxRequests: 10, subject: userId });
}

export const listWalletMerchants = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { requireMerchantWorkspaceForUserId } = await import("@/modules/identity/public/auth/authorization.server");
    const principal = await requireMerchantWorkspaceForUserId(getAuthenticatedUserId(context));
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    return sql.query<{ id: string; name: string }>(
      `select id, name from merchants where id = any($1::text[]) order by name`, [principal.merchantIds]);
  });

export const loadMerchantWallet = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId }))
  .handler(async ({ data, context }) => {
    await authorizeView(data.merchantId, getAuthenticatedUserId(context));
    const { getWalletSnapshot } = await import("@/modules/wallet/internal/wallet.server");
    return getWalletSnapshot(data.merchantId);
  });

const statementDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const loadMerchantWalletHistory = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({
    merchantId,
    kind: z.enum(["ledger", "payouts"]),
    page: z.number().int().min(1).max(1_000),
    dateFrom: statementDay.optional(),
    dateTo: statementDay.optional(),
  }))
  .handler(async ({ data, context }) => {
    await authorizeView(data.merchantId, getAuthenticatedUserId(context));
    const { loadWalletHistory } = await import("@/modules/wallet/internal/history.server");
    return loadWalletHistory(data);
  });

export const exportMerchantWalletLedger = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId, dateFrom: statementDay, dateTo: statementDay }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await authorizeView(data.merchantId, userId);
    const { enforceRateLimit } = await import("@/lib/security/rate-limit.server");
    await enforceRateLimit("merchant-wallet-statement", {
      windowSeconds: 60, maxRequests: 3, subject: userId,
    });
    const { exportWalletLedger } = await import("@/modules/wallet/internal/history.server");
    return exportWalletLedger(data);
  });

export const addMerchantPayoutDestination = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    merchantId,
    rail: z.enum(["mobile_money", "bank"]),
    accountNumber: z.string().trim().regex(/^\+?[0-9]{8,20}$/, "Enter digits only"),
    institutionCode: z.string().trim().regex(/^[A-Za-z0-9_-]{2,32}$/),
    accountName: z.string().trim().min(2).max(160),
  }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await authorizeOwnerMoneyAction(data.merchantId, userId, "wallet-destination");
    const { registerPayoutDestination } = await import("@/modules/wallet/internal/wallet.server");
    return registerPayoutDestination({ ...data, actorUserId: userId });
  });

export const previewMerchantWithdrawal = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId, amount, destinationId: z.string().trim().min(1).max(64) }))
  .handler(async ({ data, context }) => {
    await authorizeView(data.merchantId, getAuthenticatedUserId(context));
    const { quoteWithdrawal } = await import("@/modules/wallet/internal/wallet.server");
    const { driverKey: _driverKey, ...quote } = await quoteWithdrawal(data);
    return quote;
  });

export const requestMerchantWithdrawal = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    merchantId,
    amount,
    destinationId: z.string().trim().min(1).max(64),
    idempotencyKey: z.string().trim().min(16).max(128),
  }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await authorizeOwnerMoneyAction(data.merchantId, userId, "wallet-withdrawal");
    const { requestWithdrawal } = await import("@/modules/wallet/internal/wallet.server");
    const { driverKey: _driverKey, ...result } = await requestWithdrawal({ ...data, userId });
    return result;
  });

export const cancelMerchantWithdrawal = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId, payoutId: z.string().regex(/^wpo_[a-f0-9]{32}$/) }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await authorizeOwnerMoneyAction(data.merchantId, userId, "wallet-cancel");
    const { cancelWithdrawal } = await import("@/modules/wallet/internal/wallet.server");
    return cancelWithdrawal({ ...data, userId });
  });

async function requireFinanceAdmin(adminId: string) {
  const [{ requireAdminForUserId }, { requireFreshSession }] = await Promise.all([
    import("@/modules/identity/public/auth/authorization.server"),
    import("@/modules/identity/public/auth/verify.server"),
  ]);
  await requireAdminForUserId(adminId, "admin.finance.payouts");
  await requireFreshSession();
}

export const listWalletReconciliation = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    // Read-only finance staff and payout officers (who settle these items) may both see the queue.
    const { getAdminCapabilitiesForUserId } = await import("@/modules/identity/public/auth/authorization.server");
    const caps = await getAdminCapabilitiesForUserId(getAuthenticatedUserId(context));
    if (!caps.some((c) => c === "admin.full" || c === "admin.finance.view" || c === "admin.finance.payouts")) {
      throw new Error("Forbidden: administrator permission required");
    }
    const { listWalletExceptions } = await import("@/modules/wallet/internal/wallet.server");
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const quarantined = await sql.query<{ id: string; merchant_id: string; amount: string; net_amount: string; status: string; failure_reason: string | null; driver_key: string; provider_reference: string | null; updated_at: string }>(
      `select id, merchant_id, amount::text, net_amount::text, status, failure_reason, driver_key, provider_reference, updated_at::text
         from wallet_payouts where status in ('needs_attention','uncertain') order by updated_at desc limit 200`);
    const [summary] = await sql.query<{ summary: unknown }>(`select wallet_reconciliation_summary() as summary`);
    return { exceptions: JSON.parse(JSON.stringify(await listWalletExceptions("open"))), quarantined, summary: JSON.parse(JSON.stringify(summary.summary)) };
  });

// Manual payout settlement lives in administration (requestPayoutResolution) so
// high-value "paid"/"failed" decisions go through two-person approval.

export const resolveWalletReconciliationException = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ exceptionId: z.string().regex(/^\d{1,18}$/), resolution: z.string().trim().min(20).max(2000) }))
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    await requireFinanceAdmin(adminId);
    const { resolveWalletException } = await import("@/modules/wallet/internal/wallet.server");
    return resolveWalletException({ ...data, adminId });
  });

export const enableMerchantWallet = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId }))
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    const [{ requireAdminForUserId }, { requireFreshSession }] = await Promise.all([
      import("@/modules/identity/public/auth/authorization.server"),
      import("@/modules/identity/public/auth/verify.server"),
    ]);
    await requireAdminForUserId(adminId, "admin.finance.policy");
    await requireFreshSession();
    const { enableWalletForMerchant } = await import("@/modules/wallet/internal/wallet.server");
    return enableWalletForMerchant(data.merchantId, adminId);
  });
