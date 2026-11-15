// Back-office reports: date-range rules and CSV escaping / formula-injection guard.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadTypeScript } from "../scripts/helpers/load-typescript.mjs";

const range = loadTypeScript("src/modules/administration/internal/reports/report-range.ts");
const csvLayouts = loadTypeScript("src/modules/administration/internal/reports/report-csv.ts");
const { csvCell, toCsv, validateReportRange, presetRange, reportRangeSchema, REPORT_TIME_ZONE } = range;

test("CSV cells are RFC 4180 quoted", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell(" padded "), '" padded "');
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(12), "12");
  assert.equal(csvCell("100.00"), "100.00");
});

test("cells that a spreadsheet would run as a formula get a leading quote", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+233201234567"), "'+233201234567");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("@SUM(A1:A2)"), "'@SUM(A1:A2)");
  assert.equal(csvCell("\t=cmd"), "'\t=cmd");
  assert.equal(csvCell("\r=cmd"), "\"'\r=cmd\"", "guarded, then quoted because of the CR");
  assert.equal(csvCell('=HYPERLINK("http://x.test","click")'), `"'=HYPERLINK(""http://x.test"",""click"")"`);
  assert.equal(csvCell("a=b"), "a=b", "only a leading trigger is dangerous");
});

test("CSV documents use CRLF and a header row", () => {
  assert.equal(toCsv(["a", "b"], [["1", "x,y"], [2, null]]), 'a,b\r\n1,"x,y"\r\n2,\r\n');
  const merchants = csvLayouts.merchantsCsv([{ merchantId: "m1", merchantName: "=evil()", orders: 3, gmv: "10.00", refundRate: null, cancellationRate: "0.00", medianDeliveryMinutes: "42.5", openRiskFlags: 1 }]);
  assert.equal(merchants.split("\r\n")[1], "m1,'=evil(),3,10.00,,0.00,42.5,1");
});

test("report ranges: inclusive, from <= to, at most 366 days, real dates only", () => {
  assert.deepEqual(validateReportRange({ from: "2026-01-01", to: "2026-01-01" }), { from: "2026-01-01", to: "2026-01-01", days: 1 });
  assert.equal(validateReportRange({ from: "2024-01-01", to: "2024-12-31" }).days, 366, "leap year fits exactly");
  assert.equal(validateReportRange({ from: "2025-01-01", to: "2026-01-01" }).days, 366);
  assert.throws(() => validateReportRange({ from: "2025-01-01", to: "2026-01-02" }), /at most 366 days/);
  assert.throws(() => validateReportRange({ from: "2026-03-02", to: "2026-03-01" }), /on or before/);
  assert.throws(() => validateReportRange({ from: "2026-02-30", to: "2026-03-01" }), /real calendar dates/);
  assert.throws(() => validateReportRange({ from: "2026-1-1", to: "2026-01-02" }), /YYYY-MM-DD/);
  assert.throws(() => validateReportRange({ from: "1999-01-01", to: "1999-01-02" }), /between 2020 and 2100/);
  assert.equal(reportRangeSchema.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success, true);
  assert.equal(reportRangeSchema.safeParse({ from: "2026-01-02", to: "2026-01-01" }).success, false);
  assert.equal(reportRangeSchema.safeParse({ from: "2025-01-01", to: "2026-06-01" }).success, false);
  assert.equal(reportRangeSchema.safeParse({ from: "'; drop table orders; --", to: "2026-01-01" }).success, false);
});

test("presets are Accra (UTC+0) calendar days", () => {
  assert.equal(REPORT_TIME_ZONE, "Africa/Accra");
  const now = new Date("2026-03-15T23:30:00Z");
  assert.deepEqual(presetRange("today", now), { from: "2026-03-15", to: "2026-03-15" });
  assert.deepEqual(presetRange("last_7_days", now), { from: "2026-03-09", to: "2026-03-15" });
  assert.deepEqual(presetRange("last_30_days", now), { from: "2026-02-14", to: "2026-03-15" });
  assert.deepEqual(presetRange("this_month", now), { from: "2026-03-01", to: "2026-03-15" });
  assert.deepEqual(presetRange("last_month", now), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(presetRange("last_month", new Date("2026-01-10T00:00:00Z")), { from: "2025-12-01", to: "2025-12-31" });
  assert.equal(presetRange("custom", now), null);
});

test("report SQL is parameterized: dates and search never reach the SQL text", () => {
  const source = fs.readFileSync("src/modules/administration/internal/reports/admin-reports.server.ts", "utf8");
  const sqlTexts = [...source.matchAll(/`[^`]*`/g)].map((m) => m[0]).filter((t) => /\bselect\b/i.test(t));
  assert.ok(sqlTexts.length >= 8, "found the report queries");
  for (const text of sqlTexts) assert.doesNotMatch(text, /\$\{\s*(range|input|search|data)\b/, "no interpolation of request values into SQL");
  assert.match(source, /percentile_cont\(0\.5\)/);
  assert.match(source, /limit \$\{MERCHANT_REPORT_LIMIT\}/);
});
