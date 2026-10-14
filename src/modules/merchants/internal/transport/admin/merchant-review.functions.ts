import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql, withTransaction } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { runMerchantKyb } from "@/modules/merchants/public/kyb/index.server";
import { geocodeAddressServer } from "@/modules/logistics/public/adapters/location.server";

const reviewSchema = z.object({
  applicationId: z.string().min(1).max(128),
  action: z.enum(["start_review", "approve", "reject"]),
  reason: z.string().max(1000).optional(),
  manualLocation: z.object({
    latitude: z.number().finite().min(4.5).max(11.3),
    longitude: z.number().finite().min(-3.3).max(1.3),
    city: z.string().trim().min(2).max(160),
    neighborhood: z.string().trim().min(2).max(160),
    justification: z.string().trim().min(15).max(1000),
  }).optional(),
});

export const reviewMerchantApplication = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(reviewSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireAdminForUserId(userId, "admin.merchants.review");
    await requireFreshSession();
    if (data.action !== "start_review" && (!data.reason || data.reason.trim().length < 12)) throw new Error("An approval or rejection requires a documented reason of at least 12 characters");
    if (data.action === "start_review") {
      // Third-party KYB is supporting evidence, not the admin approval gate.
      // Preserve manual review when the configured provider times out/fails.
      // The review DB function is independently authoritative and audited.
      try {
        await runMerchantKyb(data.applicationId);
      } catch (error) {
        // Do not include sensitive provider payloads/credentials in logs.
        console.warn("Automated merchant KYB unavailable; proceeding to manual review", {
          applicationId: data.applicationId,
          errorType: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    const sql = await getSql();

    if (data.action === "approve") {
      const applicationRows = await sql.query<{ address: string }>(
        `select address from merchant_applications where id=$1 limit 1`,
        [data.applicationId],
      );
      const application = applicationRows[0];
      if (!application) throw new Error("Merchant application not found");

      // An administrator may supply independently verified coordinates when
      // the geocoder is unavailable or its match is incorrect. Never invent a
      // fallback position: a wrong point corrupts proximity and delivery logic.
      const location = data.manualLocation
        ? { ...data.manualLocation, state: data.manualLocation.neighborhood }
        : await geocodeAddressServer(application.address);
      // Commit activation and the manual-coordinate audit as a single unit.
      // A failed audit must not leave behind an untraceable approval.
      return withTransaction(async (transaction) => {
        const activated = await transaction.query<{ result: unknown }>(
          `select approve_and_activate_merchant_application($1,$2,$3,$4,$5,$6) as result`,
          [data.applicationId, userId, location.latitude, location.longitude,
            location.city ?? location.state ?? "Ghana", location.state ?? location.city ?? "Ghana"],
        );
        // A separate approval-decision record ties human justification to the
        // exact activation transaction. If audit insertion fails, approval rolls back.
        await transaction.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
          "admin.merchant.approval_decision", "merchant_application", data.applicationId,
          userId, "admin", null, "success", JSON.stringify({reason:data.reason?.trim(),
            manualLocation:Boolean(data.manualLocation)}),
        ]);
        if (data.manualLocation) {
          await transaction.query(
            `select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            ["merchant.location.manual_override", "merchant_application", data.applicationId,
              userId, "admin", null, "success", JSON.stringify({
                latitude: data.manualLocation.latitude, longitude: data.manualLocation.longitude,
                city: data.manualLocation.city, neighborhood: data.manualLocation.neighborhood,
                justification: data.manualLocation.justification,
              })],
          );
        }
        return activated[0]?.result ?? null;
      });
    }

    const rows = await sql.query<{ result: unknown }>(
      `select review_merchant_application($1,$2,$3,$4) as result`,
      [data.applicationId, userId, data.action, data.reason ?? null],
    );
    return rows[0]?.result ?? null;
  });
