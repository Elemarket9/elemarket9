import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";

const money = z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/, "Enter an amount in GHS");
const isoDate = z.string().trim().min(10).max(40);
const promotionId = z.string().regex(/^promo_[a-f0-9]{32}$|^[A-Za-z0-9_-]{3,80}$/);
const reason = z.string().trim().min(5).max(500);

const definition = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{4,64}$/),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(500).nullable().optional(),
  discountType: z.enum(["percentage", "fixed"]),
  discountValue: money,
  maxDiscount: money.nullable().optional(),
  minSubtotal: money,
  usageLimit: z.number().int().min(1).max(10_000_000).nullable().optional(),
  perCustomerLimit: z.number().int().min(1).max(100),
  startsAt: isoDate,
  endsAt: isoDate,
  budget: money,
  firstOrderOnly: z.boolean(),
  isPublic: z.boolean(),
  categories: z.array(z.string().trim().min(1).max(120)).max(50),
  merchantIds: z.array(z.string().trim().min(1).max(120)).max(200),
});

async function guards() {
  const [auth, verify, rate] = await Promise.all([
    import("@/modules/identity/public/auth/authorization.server"),
    import("@/modules/identity/public/auth/verify.server"),
    import("@/lib/security/rate-limit.server"),
  ]);
  return { ...auth, ...verify, ...rate };
}

/** After the permission check, every promotion mutation needs a recent sign-in and passes a shared rate limit. */
async function freshAndRateLimited(g: Awaited<ReturnType<typeof guards>>, userId: string) {
  await g.requireFreshSession();
  await g.enforceRateLimit("admin-promotions-write", { windowSeconds: 600, maxRequests: 60, subject: userId });
}

/** Marketplace promotions, merchant promotions and scope options for /admin/promotions. */
export const loadAdminPromotions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ search: z.string().trim().max(80).optional() }).optional())
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const { requireAdminForUserId } = await guards();
    await requireAdminForUserId(userId, "admin.promotions.manage");
    const svc = await import("../../admin-promotions.server");
    const [marketplace, merchant, scope] = await Promise.all([
      svc.listMarketplacePromotions(),
      svc.listMerchantPromotionsForAdmin({ search: data?.search }),
      svc.loadPromotionScopeOptions(),
    ]);
    return { marketplace, merchant, scope };
  });

export const createAdminMarketplacePromotion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(definition.extend({ activate: z.boolean() }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const g = await guards();
    await g.requireAdminForUserId(userId, "admin.promotions.manage");
    await freshAndRateLimited(g, userId);
    const { createMarketplacePromotion } = await import("../../admin-promotions.server");
    return createMarketplacePromotion(userId, data);
  });

export const updateAdminMarketplacePromotion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(definition.extend({ promotionId }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const g = await guards();
    await g.requireAdminForUserId(userId, "admin.promotions.manage");
    await freshAndRateLimited(g, userId);
    const { updateMarketplacePromotion } = await import("../../admin-promotions.server");
    return updateMarketplacePromotion(userId, data);
  });

export const pauseAdminMarketplacePromotion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ promotionId, reason }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const g = await guards();
    await g.requireAdminForUserId(userId, "admin.promotions.manage");
    await freshAndRateLimited(g, userId);
    const { setMarketplacePromotionPaused } = await import("../../admin-promotions.server");
    return setMarketplacePromotionPaused(userId, { ...data, paused: true });
  });

/** Resume a paused promotion, or activate a draft. */
export const resumeAdminMarketplacePromotion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ promotionId, reason }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const g = await guards();
    await g.requireAdminForUserId(userId, "admin.promotions.manage");
    await freshAndRateLimited(g, userId);
    const { setMarketplacePromotionPaused } = await import("../../admin-promotions.server");
    return setMarketplacePromotionPaused(userId, { ...data, paused: false });
  });

const merchantTarget = z.object({ kind: z.enum(["coupon", "flash_sale"]), id: z.string().trim().min(3).max(80), reason });

/** Hold a merchant's promotion or flash sale. Terms are never edited. */
export const pauseAdminMerchantPromotion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(merchantTarget)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const g = await guards();
    await g.requireAdminForUserId(userId, "admin.promotions.manage");
    await freshAndRateLimited(g, userId);
    const { setMerchantPromotionHold } = await import("../../admin-promotions.server");
    return setMerchantPromotionHold(userId, { ...data, paused: true });
  });

export const resumeAdminMerchantPromotion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(merchantTarget)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const g = await guards();
    await g.requireAdminForUserId(userId, "admin.promotions.manage");
    await freshAndRateLimited(g, userId);
    const { setMerchantPromotionHold } = await import("../../admin-promotions.server");
    return setMerchantPromotionHold(userId, { ...data, paused: false });
  });
