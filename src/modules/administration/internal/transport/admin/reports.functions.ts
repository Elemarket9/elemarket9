import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { buildReportExport, loadAdminReport, type AdminReport } from "../../reports/admin-reports.server";
import { REPORT_EXPORT_SECTIONS, reportRangeSchema } from "../../reports/report-range";

export type { AdminReport } from "../../reports/admin-reports.server";

const searchSchema = z.string().trim().max(100).optional();
const reportInput = reportRangeSchema.and(z.object({ search: searchSchema }));
const exportInput = reportRangeSchema.and(z.object({ section: z.enum(REPORT_EXPORT_SECTIONS), search: searchSchema }));

/** Read-only sales, refunds, delivery, merchant and category report for a date range. */
export const loadAdminReports = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(reportInput)
  .handler(async ({ data, context }): Promise<AdminReport> => {
    const userId = getAuthenticatedUserId(context);
    await requireAdminForUserId(userId, "admin.reports.view");
    await enforceRateLimit("admin-reports-view", { windowSeconds: 60, maxRequests: 30, subject: userId });
    const sql = await getSql();
    return loadAdminReport(sql, { from: data.from, to: data.to, search: data.search || null });
  });

/**
 * CSV export of the daily series, merchant table or category table. Returns CSV
 * text (the browser saves it). Rate-limited and audited with the range and
 * section only; no row data goes into the audit record.
 */
export const exportAdminReportCsv = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(exportInput)
  .handler(async ({ data, context }): Promise<{ filename: string; csv: string }> => {
    const userId = getAuthenticatedUserId(context);
    await requireAdminForUserId(userId, "admin.reports.view");
    await enforceRateLimit("admin-reports-export", { windowSeconds: 3600, maxRequests: 20, subject: userId });
    const sql = await getSql();
    return buildReportExport(sql, { from: data.from, to: data.to, section: data.section, search: data.search || null, actorId: userId });
  });
