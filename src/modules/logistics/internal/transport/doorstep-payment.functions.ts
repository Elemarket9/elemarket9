import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { getSql } from "@/lib/db";
import { isSharedEnvironment } from "@/lib/env.server";
import { requireDeliveryRiderForJob } from "@/lib/partner/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const jobId = z.string().trim().min(1).max(128);

/**
 * The person at the door: the rider (door delivery) or attendant (pickup point)
 * assigned to this in-transit job, for a shipped, unpaid pay-on-delivery order.
 * Mirrors the OTP request's eligibility so payment and handover share one gate.
 */
async function doorstepOrder(actor: string, job: string): Promise<string> {
  const access = await requireDeliveryRiderForJob(actor, job);
  const sql = await getSql();
  const [row] = await sql.query<{ order_id: string }>(
    `select o.id as order_id
       from delivery_jobs j join orders o on o.id = j.order_id
       join delivery_providers p on p.id = j.provider_id
      where j.id = $1 and p.partner_organization_id = $2 and p.status = 'active'
        and (not $4::boolean or p.environment = 'production')
        and j.handover_rider_user_id = $3 and elemarket_authorized_handover_person(j.id, $3)
        and j.status = 'in_transit' and (j.handover_kind = 'delivery' or j.pickup_arrived_at is not null)
        and o.status = 'shipped' and o.payment_timing = 'on_delivery'
        and o.delivery_contact_snapshot_verified = true
        and not exists(select 1 from order_delivery_holds h where h.order_id = o.id and h.active)`,
    [job, access.organizationId, actor, isSharedEnvironment()]);
  if (!row) throw new Error("Only the assigned rider or attendant can collect payment for this delivery");
  return row.order_id;
}

/** Send the customer a mobile money approval prompt, or report where it stands. */
export const requestDoorstepPayment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ jobId }))
  .handler(async ({ data, context }) => {
    const actor = getAuthenticatedUserId(context);
    await enforceRateLimit("doorstep-payment", { windowSeconds: 600, maxRequests: 8, subject: `${data.jobId}:${actor}` });
    const orderId = await doorstepOrder(actor, data.jobId);
    const { requestPayOnDeliveryPrompt } = await import("@/modules/payments/public/pay-on-delivery.server");
    return requestPayOnDeliveryPrompt(orderId);
  });

/** Networks that need it (Telecel): the voucher code the customer generated. */
export const submitDoorstepPaymentCode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ jobId, code: z.string().trim().regex(/^[A-Za-z0-9]{3,12}$/) }))
  .handler(async ({ data, context }) => {
    const actor = getAuthenticatedUserId(context);
    await enforceRateLimit("doorstep-payment-code", { windowSeconds: 600, maxRequests: 5, subject: `${data.jobId}:${actor}` });
    const orderId = await doorstepOrder(actor, data.jobId);
    const { submitPayOnDeliveryCode } = await import("@/modules/payments/public/pay-on-delivery.server");
    return submitPayOnDeliveryCode(orderId, data.code);
  });
