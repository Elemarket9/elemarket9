import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { getAdminCapabilitiesForUserId, requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { AdminOrderSearchError, adminOrderSearchSchema, normalizeAdminOrderSearch } from "../../admin-orders";
import {
  addAdminOrderNote, cancelUnpaidOrderAsAdmin, getAdminOrderDetail, revealAdminOrderContact,
  searchAdminOrders, setOrderDeliveryHoldAsAdmin,
} from "../../admin-orders.server";

export type { AdminOrderDetail, AdminOrderListRow } from "../../admin-orders.server";
export type { OrderTimelineEntry } from "../../admin-orders";

const orderIdSchema = z.object({ orderId: z.string().trim().min(1).max(128) });
const READ_CAPABILITIES = ["admin.full", "admin.orders.view", "admin.orders.manage"];

/** Read access: admin.orders.view or admin.orders.manage (Main Administrator: admin.full). */
async function assertOrderReader(capabilities: readonly string[]) {
  if (!capabilities.some((c) => READ_CAPABILITIES.includes(c))) throw new Error("Forbidden: administrator permission required");
}

/** Mutations: the permission, then a recently created session, then a rate limit. */
async function assertFreshActor(actor: string) {
  if ((await requireFreshSession()) !== actor) throw new Error("Fresh administrator authentication required");
}

/** POST so customer email/phone filters never appear in URLs or access logs. */
export const searchAdminOrderList = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(adminOrderSearchSchema)
  .handler(async ({ data, context }) => {
    const actor = getAuthenticatedUserId(context);
    await assertOrderReader(await getAdminCapabilitiesForUserId(actor));
    await enforceRateLimit("admin-orders-search", { windowSeconds: 60, maxRequests: 60, subject: actor });
    try {
      return { ...(await searchAdminOrders(normalizeAdminOrderSearch(data))), error: null as string | null };
    } catch (e) {
      // Bad search input is answered in plain language, not as a server error.
      if (e instanceof AdminOrderSearchError) return { orders: [], nextCursor: null, error: e.message };
      throw e;
    }
  });

export const loadAdminOrderDetail = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(orderIdSchema)
  .handler(async ({ data, context }) => {
    const actor = getAuthenticatedUserId(context);
    const capabilities = await getAdminCapabilitiesForUserId(actor);
    await assertOrderReader(capabilities);
    await enforceRateLimit("admin-orders-detail", { windowSeconds: 60, maxRequests: 120, subject: actor });
    const detail = await getAdminOrderDetail(data.orderId);
    return { detail, canManage: capabilities.includes("admin.full") || capabilities.includes("admin.orders.manage") };
  });

export const addAdminOrderInternalNote = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(orderIdSchema.extend({ body: z.string().trim().min(3).max(2000) }))
  .handler(async ({ data, context }) => {
    const actor = getAuthenticatedUserId(context);
    await requireAdminForUserId(actor, "admin.orders.manage");
    await assertFreshActor(actor);
    await enforceRateLimit("admin-orders-note", { windowSeconds: 60, maxRequests: 30, subject: actor });
    return addAdminOrderNote({ orderId: data.orderId, adminId: actor, body: data.body });
  });

export const setAdminOrderDeliveryHold = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(orderIdSchema.extend({ action: z.enum(["hold", "release"]), reason: z.string().trim().min(12).max(1000) }))
  .handler(async ({ data, context }) => {
    const actor = getAuthenticatedUserId(context);
    await requireAdminForUserId(actor, "admin.orders.manage");
    await assertFreshActor(actor);
    await enforceRateLimit("admin-orders-delivery-hold", { windowSeconds: 300, maxRequests: 20, subject: actor });
    return setOrderDeliveryHoldAsAdmin({ orderId: data.orderId, adminId: actor, action: data.action, reason: data.reason });
  });

export const cancelUnpaidAdminOrder = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(orderIdSchema.extend({ reason: z.string().trim().min(12).max(1000) }))
  .handler(async ({ data, context }) => {
    const actor = getAuthenticatedUserId(context);
    await requireAdminForUserId(actor, "admin.orders.manage");
    await assertFreshActor(actor);
    await enforceRateLimit("admin-orders-cancel", { windowSeconds: 300, maxRequests: 10, subject: actor });
    return cancelUnpaidOrderAsAdmin({ orderId: data.orderId, adminId: actor, reason: data.reason });
  });

export const revealAdminOrderCustomerContact = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(orderIdSchema.extend({ reason: z.string().trim().min(8).max(300) }))
  .handler(async ({ data, context }) => {
    const actor = getAuthenticatedUserId(context);
    await requireAdminForUserId(actor, "admin.orders.manage");
    await assertFreshActor(actor);
    await enforceRateLimit("admin-orders-contact-reveal", { windowSeconds: 3600, maxRequests: 30, subject: actor });
    return revealAdminOrderContact({ orderId: data.orderId, adminId: actor, reason: data.reason });
  });
