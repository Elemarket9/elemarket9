import { withTransaction } from "@/lib/db";

export type OrderDeliveryHoldAction = "hold" | "release";

/** Orders whose shipment can still be stopped. */
export const DELIVERY_HOLD_ELIGIBLE_STATUSES = ["paid", "confirmed", "fulfilling", "shipped"] as const;

/**
 * Place or release a delivery hold on an order, with its audit event, in one
 * transaction. A hold is a shipment STOP, never an address-change bypass.
 *
 * Server-only and permission-free: every caller MUST first authorize the actor
 * (support: admin.support; orders: admin.orders.manage), apply its fresh-session
 * rule and rate limit. `auditEventType` names the channel that acted.
 */
export async function applyOrderDeliveryHold(input: {
  orderId: string;
  action: OrderDeliveryHoldAction;
  reason: string;
  actorId: string;
  auditEventType: string;
}): Promise<{ action: OrderDeliveryHoldAction; orderId: string }> {
  const { orderId, action, reason, actorId, auditEventType } = input;
  if (action !== "hold" && action !== "release") throw new Error("Unknown delivery hold action");
  if (reason.trim().length < 12 || reason.length > 1000) throw new Error("A reason of 12-1000 characters is required");
  return withTransaction(async (tx) => {
    const orders = await tx.query<{ id: string; status: string }>(`select id,status from orders where id=$1 for update`, [orderId]);
    if (!orders[0]) throw new Error("Order not found");
    if (action === "hold") {
      if (!(DELIVERY_HOLD_ELIGIBLE_STATUSES as readonly string[]).includes(orders[0].status)) throw new Error("Shipment is not eligible for a delivery hold");
      await tx.query(`insert into order_delivery_holds(order_id,reason,placed_by,active)
        values($1,$2,$3,true) on conflict(order_id) do update set active=true,reason=excluded.reason,placed_by=excluded.placed_by,placed_at=now(),released_at=null,released_by=null,release_reason=null,updated_at=now()`, [orderId, reason, actorId]);
    } else {
      const changed = await tx.query<{ order_id: string }>(`update order_delivery_holds set active=false,released_by=$2,released_at=now(),release_reason=$3,updated_at=now()
        where order_id=$1 and active=true returning order_id`, [orderId, actorId, reason]);
      if (!changed[0]) throw new Error("No active delivery hold");
    }
    await tx.query(`select record_audit_event($1,'order',$2,$3,'admin',null,'success',$4::jsonb)`,
      [auditEventType, orderId, actorId, JSON.stringify({ reason })]);
    return { action, orderId };
  });
}
