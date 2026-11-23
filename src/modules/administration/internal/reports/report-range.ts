// Pure helpers for the back-office reports: date ranges and CSV export.
// No server or database imports, so the browser and unit tests can use them.
import { z } from "zod";

/** Reports read calendar days in Ghana time. Africa/Accra is UTC+0 all year (no daylight saving). */
export const REPORT_TIME_ZONE = "Africa/Accra";
export const REPORT_MAX_DAYS = 366;
export const REPORT_PRESETS = ["today", "last_7_days", "last_30_days", "this_month", "last_month", "custom"] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];
export const REPORT_EXPORT_SECTIONS = ["daily", "merchants", "categories"] as const;
export type ReportExportSection = (typeof REPORT_EXPORT_SECTIONS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function parseIsoDate(value: string): number | null {
  if (!ISO_DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  // Reject dates JavaScript silently rolls over (e.g. 2026-02-30 -> 2026-03-02).
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms;
}

export type ReportRange = { from: string; to: string; days: number };

/** Inclusive calendar-day range [from, to]; from <= to; at most REPORT_MAX_DAYS days. */
export function validateReportRange(input: { from: string; to: string }): ReportRange {
  const from = parseIsoDate(input.from);
  const to = parseIsoDate(input.to);
  if (from === null || to === null) throw new Error("Dates must be real calendar dates written as YYYY-MM-DD.");
  if (from < Date.UTC(2020, 0, 1) || to > Date.UTC(2100, 0, 1)) throw new Error("Dates must be between 2020 and 2100.");
  if (from > to) throw new Error("The start date must be on or before the end date.");
  const days = Math.round((to - from) / DAY_MS) + 1;
  if (days > REPORT_MAX_DAYS) throw new Error(`A report can cover at most ${REPORT_MAX_DAYS} days.`);
  return { from: input.from, to: input.to, days };
}

export const reportRangeSchema = z
  .object({ from: z.string().regex(ISO_DATE), to: z.string().regex(ISO_DATE) })
  .superRefine((value, ctx) => {
    try { validateReportRange(value); }
    catch (e) { ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : "Invalid range" }); }
  });

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Calendar range for a preset, in Accra time (= UTC). `custom` returns null. */
export function presetRange(preset: ReportPreset, now: Date = new Date()): { from: string; to: string } | null {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (preset) {
    case "today": return { from: iso(today), to: iso(today) };
    case "last_7_days": return { from: iso(today - 6 * DAY_MS), to: iso(today) };
    case "last_30_days": return { from: iso(today - 29 * DAY_MS), to: iso(today) };
    case "this_month": return { from: iso(Date.UTC(y, m, 1)), to: iso(today) };
    case "last_month": return { from: iso(Date.UTC(y, m - 1, 1)), to: iso(Date.UTC(y, m, 0)) };
    default: return null;
  }
}

// ---- CSV ----------------------------------------------------------------------

/** Characters that make spreadsheet apps treat a cell as a formula (CSV/formula injection). */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** One CSV cell: formula-injection guard first, then RFC 4180 quoting. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** CSV text with a header row and CRLF line endings. */
export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
