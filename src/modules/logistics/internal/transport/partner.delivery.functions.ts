import { isSharedEnvironment } from "@/lib/env.server";
import type { JsonObject } from "@/lib/db-types";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { getSql, withTransaction } from "@/lib/db";
import { requirePartnerAccess } from "@/lib/partner/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { assignDeliveryManually } from "../dispatch.server";

export const assignOrderDelivery = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ orderId: z.string().trim().min(1).max(128) }))
  .handler(async ({ data }) => assignDeliveryManually(data.orderId));

export const loadDeliveryPartnerDashboard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = getAuthenticatedUserId(context);
    const access = await requirePartnerAccess(userId, "delivery");
    const sql = await getSql();
    const providers = await sql.query<{
      id: string;
      name: string;
      status: string;
      environment: string;
    }>(
      `select id,name,status,environment from delivery_providers where partner_organization_id=$1 order by name`,
      [access.organizationId],
    );
    const jobs = await sql.query<JsonObject>(
      `select j.id,j.order_id as "orderId",j.status,j.provider_reference as "providerReference",j.tracking_url as "trackingUrl",j.proof_of_delivery_url as "proofOfDeliveryUrl",j.failure_reason as "failureReason",j.version,j.assigned_at::text as "assignedAt",j.accepted_at::text as "acceptedAt",j.picked_up_at::text as "pickedUpAt",j.in_transit_at::text as "inTransitAt",j.delivered_at::text as "deliveredAt",j.failed_at::text as "failedAt",j.updated_at::text as "updatedAt",o.address,o.delivery_tier as "deliveryTier",o.delivery_total::float8 as "deliveryTotal",m.name as "merchantName",p.name as "providerName" from delivery_jobs j join delivery_providers p on p.id=j.provider_id and p.partner_organization_id=$1 join orders o on o.id=j.order_id join merchants m on m.id=o.merchant_id order by j.updated_at desc limit 200`,
      [access.organizationId],
    );
    const counts = await sql.query<{ status: string; count: number }>(
      `select j.status,count(*)::bigint as count from delivery_jobs j join delivery_providers p on p.id=j.provider_id where p.partner_organization_id=$1 group by j.status`,
      [access.organizationId],
    );
    return { organization: access.organizationName, role: access.role, providers, jobs, counts };
  });
const updateSchema = z
  .object({
    jobId: z.string().min(1).max(128),
    expectedVersion: z.number().int().nonnegative(),
    status: z.enum([
      "accepted",
      "picked_up",
      "in_transit",
      "delivered",
      "failed",
      "return_requested",
      "returned",
    ]),
    trackingUrl: z
      .string()
      .url()
      .max(2000)
      .refine((v) => v.startsWith("https://"), "HTTPS tracking URL required")
      .optional(),
    proofOfDeliveryUrl: z
      .string()
      .url()
      .max(2000)
      .refine((v) => v.startsWith("https://"), "HTTPS proof URL required")
      .optional(),
    failureReason: z.string().trim().max(500).optional(),
  })
  .superRefine((v, c) => {
    if (v.status === "delivered" && !v.proofOfDeliveryUrl)
      c.addIssue({
        code: "custom",
        message: "Proof of delivery is required",
        path: ["proofOfDeliveryUrl"],
      });
    if (v.status === "failed" && !v.failureReason)
      c.addIssue({
        code: "custom",
        message: "Failure reason is required",
        path: ["failureReason"],
      });
  });
export const updateDeliveryJob = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(updateSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const access = await requirePartnerAccess(userId, "delivery", true);
    await enforceRateLimit("partner-delivery-update", {
      windowSeconds: 60,
      maxRequests: 60,
      subject: `${access.organizationId}:${userId}`,
    });
    // Delivery changes and partner audit must commit or roll back together.
    return withTransaction(async (sql) => {
      const rows = await sql.query<{ id: string }>(
        `update delivery_jobs j set status=$3,tracking_url=coalesce($4,tracking_url),proof_of_delivery_url=coalesce($5,proof_of_delivery_url),failure_reason=case when $3='failed' then $6 else failure_reason end,picked_up_at=case when $3='picked_up' then coalesce(picked_up_at,now()) else picked_up_at end,delivered_at=case when $3='delivered' then coalesce(delivered_at,now()) else delivered_at end,updated_at=now() from delivery_providers p where j.id=$1 and p.id=j.provider_id and p.partner_organization_id=$2 and p.status='active' and (not $8::boolean or p.environment='production') and j.version=$7 returning j.id,j.version`,
        [
          data.jobId,
          access.organizationId,
          data.status,
          data.trackingUrl ?? null,
          data.proofOfDeliveryUrl ?? null,
          data.failureReason ?? null,
          data.expectedVersion,
          isSharedEnvironment(),
        ],
      );
      if (rows.length !== 1)
        throw new Error("Delivery job changed or is no longer available; refresh and retry");
      await sql.query(
        `insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'delivery.status.updated','delivery_job',$3,'success',$4::jsonb)`,
        [access.organizationId, userId, data.jobId, JSON.stringify({ status: data.status })],
      );
      return { updated: true };
    });
  });
