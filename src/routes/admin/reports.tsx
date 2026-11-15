import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { exportAdminReportCsv, loadAdminReports, type AdminReport } from "@/modules/administration/public/transport/admin/reports.functions";
import {
  REPORT_MAX_DAYS, REPORT_PRESETS, presetRange, validateReportRange, type ReportExportSection, type ReportPreset,
} from "@/modules/administration/public/reports/report-range";

const searchSchema = z.object({
  preset: z.enum(REPORT_PRESETS).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  q: z.string().max(100).optional(),
});

function resolveRange(search: z.infer<typeof searchSchema>) {
  const preset: ReportPreset = search.preset ?? (search.from || search.to ? "custom" : "last_30_days");
  const fixed = presetRange(preset);
  return { preset, from: fixed?.from ?? search.from ?? "", to: fixed?.to ?? search.to ?? "" };
}

export const Route = createFileRoute("/admin/reports")({
  head: () => ({ meta: [{ title: "Reports | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const access = await getAdminAccessState();
    if (!(access.staffRole === "owner" || access.capabilities.includes("admin.reports.view"))) throw redirect({ to: "/admin" });
    const range = resolveRange(deps);
    try {
      validateReportRange(range);
    } catch (e) {
      return { access, range, q: deps.q ?? "", report: null, error: e instanceof Error ? e.message : "Invalid date range." };
    }
    try {
      const report = await loadAdminReports({ data: { from: range.from, to: range.to, search: deps.q || undefined } });
      return { access, range, q: deps.q ?? "", report, error: null };
    } catch (e) {
      return { access, range, q: deps.q ?? "", report: null, error: errorText(e) };
    }
  },
  component: Reports,
  errorComponent: () => (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl font-black">Reports access required</h1>
      <p className="mt-3 text-sm text-market-muted">Ask the Main Administrator for the reports permission.</p>
    </main>
  ),
});

type Report = AdminReport;

const PRESET_LABEL: Record<ReportPreset, string> = {
  today: "Today", last_7_days: "Last 7 days", last_30_days: "Last 30 days",
  this_month: "This month", last_month: "Last month", custom: "Custom dates",
};

const ghs = (v: string | null | undefined) =>
  v === null || v === undefined ? "—" : `GH₵ ${Number(v).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `${Number(v).toLocaleString("en-GH", { maximumFractionDigits: 2 })}%`);
const count = (n: number) => n.toLocaleString("en-GH");
function duration(minutes: string | null | undefined) {
  if (minutes === null || minutes === undefined) return "—";
  const m = Math.round(Number(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GH", { day: "numeric", month: "short", timeZone: "UTC" });

function errorText(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  if (/rate|too many/i.test(m)) return "Too many requests. Please wait a minute and try again.";
  if (/forbidden|permission/i.test(m)) return "You don't have the reports permission.";
  return m || "The report could not be loaded. Please try again.";
}

function Panel({ title, intro, actions, children }: { title: string; intro?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const id = `panel-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="mt-6 rounded-2xl border border-market-line bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={id} className="text-xl font-black">{title}</h2>
          {intro ? <p className="mt-1 text-sm text-market-muted">{intro}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-market-line bg-market-soft/40 p-4">
      <dt className="text-xs font-bold uppercase tracking-wide text-market-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-black tabular-nums">{value}</dd>
      {hint ? <dd className="mt-1 text-xs text-market-muted">{hint}</dd> : null}
    </div>
  );
}

function Reports() {
  const { access, range, q, report, error } = Route.useLoaderData();
  const navigate = useNavigate({ from: "/admin/reports" });
  const [preset, setPreset] = useState<ReportPreset>(range.preset);
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [search, setSearch] = useState(q);
  const [formError, setFormError] = useState<string | null>(null);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const chosen = preset === "custom" ? { from, to } : presetRange(preset)!;
    try { validateReportRange(chosen); } catch (err) { setFormError(err instanceof Error ? err.message : "Invalid dates."); return; }
    void navigate({
      search: preset === "custom"
        ? { preset, from: chosen.from, to: chosen.to, q: search.trim() || undefined }
        : { preset, q: search.trim() || undefined },
    });
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
      <header className="rounded-3xl border border-market-line bg-white p-6">
        <p className="text-xs font-black uppercase tracking-widest text-market-muted">Back office · read only</p>
        <h1 className="mt-2 text-3xl font-black">Reports</h1>
        <p className="mt-2 text-sm text-market-muted">
          Dates are calendar days in Ghana time (Africa/Accra, which is UTC+0 all year). A <strong>paid order</strong> is one
          whose payment the provider confirmed as completed; it is counted on the day the payment completed. Unpaid,
          expired or cancelled-before-payment checkouts are never counted as sales. Each merchant&apos;s part of a checkout
          is one order.
        </p>
      </header>

      <form onSubmit={apply} className="mt-5 grid gap-3 rounded-2xl border border-market-line bg-white p-5 sm:grid-cols-2 lg:grid-cols-5" aria-label="Report date range">
        <label className="text-sm font-bold">Period
          <select value={preset} onChange={(e) => setPreset(e.target.value as ReportPreset)} className="mt-1 w-full rounded-xl border border-market-line p-2">
            {REPORT_PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABEL[p]}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold">From
          <input type="date" value={preset === "custom" ? from : presetRange(preset)?.from ?? ""} disabled={preset !== "custom"}
            onChange={(e) => setFrom(e.target.value)} className="mt-1 w-full rounded-xl border border-market-line p-2 disabled:bg-market-soft" />
        </label>
        <label className="text-sm font-bold">To
          <input type="date" value={preset === "custom" ? to : presetRange(preset)?.to ?? ""} disabled={preset !== "custom"}
            onChange={(e) => setTo(e.target.value)} className="mt-1 w-full rounded-xl border border-market-line p-2 disabled:bg-market-soft" />
        </label>
        <label className="text-sm font-bold">Merchant search
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} placeholder="Name or ID"
            className="mt-1 w-full rounded-xl border border-market-line p-2" />
        </label>
        <div className="flex items-end">
          <button type="submit" className="w-full rounded-xl bg-market-green px-4 py-2 font-black text-white">Show report</button>
        </div>
        <p className="text-xs text-market-muted sm:col-span-2 lg:col-span-5">Up to {REPORT_MAX_DAYS} days per report.</p>
        {formError ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800 sm:col-span-2 lg:col-span-5">{formError}</p> : null}
      </form>

      {error ? <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">{error}</p> : null}
      {report ? <ReportBody report={report} q={q} /> : null}
    </main>
  );
}

function useExport(report: Report, q: string) {
  const [busy, setBusy] = useState<ReportExportSection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (section: ReportExportSection) => {
    setBusy(section); setMessage(null);
    try {
      const { filename, csv } = await exportAdminReportCsv({
        data: { from: report.range.from, to: report.range.to, section, search: section === "merchants" && q ? q : undefined },
      });
      // Byte-order mark so spreadsheet apps read GH₵ and names as UTF-8.
      const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, message, run };
}

function ExportButton({ section, label, exporter }: { section: ReportExportSection; label: string; exporter: ReturnType<typeof useExport> }) {
  return (
    <button type="button" disabled={exporter.busy !== null} onClick={() => void exporter.run(section)}
      className="rounded-xl border border-market-line px-3 py-2 text-sm font-bold disabled:opacity-50">
      {exporter.busy === section ? "Preparing…" : label}
    </button>
  );
}

function ReportBody({ report, q }: { report: Report; q: string }) {
  const { sales, refunds, delivery } = report;
  const exporter = useExport(report, q);
  return (
    <>
      <p className="mt-5 text-sm text-market-muted" aria-live="polite">
        Showing {dayLabel(report.range.from)} – {dayLabel(report.range.to)} ({report.range.days} {report.range.days === 1 ? "day" : "days"}).
        Generated {new Date(report.generatedAt).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Accra" })} Ghana time.
      </p>
      {exporter.message ? <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">{exporter.message}</p> : null}

      <Panel title="Sales" intro="Paid orders only. Merchandise value is the product total after discounts, without delivery."
        actions={<ExportButton section="daily" label="Download daily CSV" exporter={exporter} />}>
        <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat label="Merchandise value (GMV)" value={ghs(sales.gmv)} />
          <Stat label="Paid orders" value={count(sales.orders)} />
          <Stat label="Average order value" value={ghs(sales.averageOrderValue)} hint="Amount paid incl. delivery ÷ paid orders" />
          <Stat label="Delivery fees" value={ghs(sales.deliveryFees)} />
          <Stat label="ELEMARKET commission" value={ghs(sales.commission)} />
          <Stat label="Merchant earnings" value={ghs(sales.merchantEarnings)} hint="Merchandise value minus commission" />
        </dl>
        <DailyChart daily={sales.daily} />
      </Panel>

      <Panel title="Refunds & cancellations">
        <h3 className="mt-4 text-sm font-black">Refund requests opened in this period</h3>
        <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Refunded" value={ghs(refunds.requested.processedAmount)} hint={`${count(refunds.requested.processedCount)} confirmed by the provider`} />
          <Stat label="In progress" value={ghs(refunds.requested.pendingAmount)} hint={`${count(refunds.requested.pendingCount)} waiting or needing attention`} />
          <Stat label="Failed" value={ghs(refunds.requested.failedAmount)} hint={`${count(refunds.requested.failedCount)} failed at the provider`} />
        </dl>
        <h3 className="mt-5 text-sm font-black">Of the {count(refunds.paidOrders)} orders paid in this period</h3>
        <dl className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Refund rate (orders)" value={pct(refunds.refundRateByCount)} hint={`${count(refunds.refundedOrders)} refunded`} />
          <Stat label="Refund rate (value)" value={pct(refunds.refundRateByValue)} hint={`${ghs(refunds.refundedValue)} of ${ghs(refunds.paidValue)} paid`} />
          <Stat label="Cancelled after payment" value={pct(refunds.cancelledAfterPaymentRate)} hint={`${count(refunds.cancelledAfterPayment)} refunded or refunding before delivery`} />
          <Stat label="Unpaid checkouts cancelled" value={pct(refunds.unpaidCancelledRate)} hint={`${count(refunds.unpaidCancelled)} of ${count(refunds.ordersPlaced)} placed in this period`} />
        </dl>
        <h3 className="mt-5 text-sm font-black">Returns opened in this period</h3>
        <dl className="mt-2 grid grid-cols-3 gap-3">
          <Stat label="Opened" value={count(refunds.returns.opened)} />
          <Stat label="Approved" value={count(refunds.returns.approved)} />
          <Stat label="Refunded" value={count(refunds.returns.refunded)} />
        </dl>
        <p className="mt-3 text-xs text-market-muted">Only refunds the provider confirmed count as refunded. Refunds return the full amount paid, including delivery, so the value rate is measured against the amount paid.</p>
      </Panel>

      <Panel title="Delivery" intro="Time from payment to the customer's verified handover code, for door deliveries paid up front.">
        <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Median paid → delivered" value={duration(delivery.medianMinutes)} hint={`${count(delivery.timedDeliveries)} deliveries measured`} />
          <Stat label="90% delivered within" value={duration(delivery.p90Minutes)} />
          <Stat label="On time (within quoted ETA)" value={pct(delivery.withinEtaRate)} hint={`${count(delivery.withinEta)} of ${count(delivery.timedDeliveries)}`} />
          <Stat label="Late right now" value={count(delivery.currentlyLate)} hint="Open door deliveries past their ETA (all dates)" />
        </dl>
        <p className="mt-3 text-sm">
          Paid orders by method: <strong>{count(delivery.doorOrders)}</strong> door delivery · <strong>{count(delivery.pickupOrders)}</strong> pickup point.
        </p>
        <p className="mt-1 text-xs text-market-muted">Pay-on-delivery orders are paid at the door and pickup orders wait for the customer to collect, so neither is included in delivery times.</p>
      </Panel>

      <MerchantTable rows={report.merchants} q={q} exporter={exporter} />
      <CategoryTable rows={report.categories} exporter={exporter} />
    </>
  );
}

function DailyChart({ daily }: { daily: Report["sales"]["daily"] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...daily.map((d) => Number(d.gmv)));
  const total = daily.reduce((s, d) => s + Number(d.gmv), 0);
  const W = 640, H = 200, top = 8, bottom = 4;
  const slot = W / Math.max(1, daily.length);
  const gap = daily.length > 120 ? 0.5 : 2;
  const barW = Math.max(1, slot - gap);
  const shown = active !== null ? daily[active] : null;
  const busiest = daily.reduce<Report["sales"]["daily"][number] | null>((b, d) => (!b || Number(d.gmv) > Number(b.gmv) ? d : b), null);
  const summary = max === 0
    ? "Daily merchandise value: no paid orders in this period."
    : `Daily merchandise value bar chart, ${daily.length} days, total ${ghs(String(total))}; highest ${ghs(busiest!.gmv)} on ${dayLabel(busiest!.day)}.`;
  return (
    <figure className="mt-6">
      <figcaption className="text-sm font-black">Merchandise value per day</figcaption>
      <p className="mt-1 min-h-5 text-xs text-market-muted" aria-live="polite">
        {shown ? <>{dayLabel(shown.day)}: <strong>{ghs(shown.gmv)}</strong> · {count(shown.orders)} orders</> : <>Peak {ghs(String(max))}. Hover or tap a bar for the day.</>}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-48 w-full" preserveAspectRatio="none" role="img" aria-label={summary}
        onMouseLeave={() => setActive(null)}>
        <line x1={0} x2={W} y1={H - bottom} y2={H - bottom} stroke="currentColor" className="text-market-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {daily.map((d, i) => {
          const v = Number(d.gmv);
          const h = max > 0 ? ((H - top - bottom) * v) / max : 0;
          const x = i * slot + gap / 2;
          return (
            <g key={d.day}>
              {h > 0 ? (
                <rect x={x} y={H - bottom - h} width={barW} height={h} rx={Math.min(4, barW / 2)}
                  className={active === i ? "fill-market-orange" : "fill-market-green"} />
              ) : null}
              {/* Full-height hit target, larger than the bar. */}
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent"
                onMouseEnter={() => setActive(i)} onClick={() => setActive(i)}>
                <title>{`${dayLabel(d.day)}: ${ghs(d.gmv)}, ${d.orders} orders`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      {daily.length ? (
        <div className="mt-1 flex justify-between text-xs text-market-muted" aria-hidden="true">
          <span>{dayLabel(daily[0].day)}</span>
          <span>{dayLabel(daily[daily.length - 1].day)}</span>
        </div>
      ) : null}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-bold">Show daily numbers as a table</summary>
        <div className="mt-2 max-h-80 overflow-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Paid orders per day</caption>
            <thead className="sticky top-0 bg-white text-xs uppercase text-market-muted">
              <tr><th scope="col" className="py-2 pr-3">Day</th><th scope="col" className="py-2 pr-3 text-right">Orders</th><th scope="col" className="py-2 pr-3 text-right">GMV</th><th scope="col" className="hidden py-2 pr-3 text-right sm:table-cell">Delivery</th><th scope="col" className="hidden py-2 text-right sm:table-cell">Commission</th></tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.day} className="border-t border-market-line">
                  <th scope="row" className="py-1.5 pr-3 font-normal">{d.day}</th>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{count(d.orders)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{ghs(d.gmv)}</td>
                  <td className="hidden py-1.5 pr-3 text-right tabular-nums sm:table-cell">{ghs(d.deliveryFees)}</td>
                  <td className="hidden py-1.5 text-right tabular-nums sm:table-cell">{ghs(d.commission)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

type MerchantRow = Report["merchants"][number];
type SortKey = "merchantName" | "orders" | "gmv" | "refundRate" | "cancellationRate" | "medianDeliveryMinutes" | "openRiskFlags";
const MERCHANT_COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "merchantName", label: "Merchant", numeric: false },
  { key: "orders", label: "Orders", numeric: true },
  { key: "gmv", label: "GMV", numeric: true },
  { key: "refundRate", label: "Refund rate", numeric: true },
  { key: "cancellationRate", label: "Cancelled after payment", numeric: true },
  { key: "medianDeliveryMinutes", label: "Median delivery", numeric: true },
  { key: "openRiskFlags", label: "Open risk flags", numeric: true },
];

function MerchantTable({ rows, q, exporter }: { rows: MerchantRow[]; q: string; exporter: ReturnType<typeof useExport> }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "gmv", dir: "desc" });
  const sorted = useMemo(() => {
    const col = MERCHANT_COLUMNS.find((c) => c.key === sort.key)!;
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      if (av === null || av === undefined) return 1; // empty values last either way
      if (bv === null || bv === undefined) return -1;
      return col.numeric ? sign * (Number(av) - Number(bv)) : sign * String(av).localeCompare(String(bv));
    });
  }, [rows, sort]);
  const toggle = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));
  return (
    <Panel title="Merchant performance"
      intro={<>Top 50 merchants by merchandise value in this period{q ? <> matching “{q}”</> : null}. Open risk flags are as of now.</>}
      actions={<ExportButton section="merchants" label="Download CSV" exporter={exporter} />}>
      {rows.length === 0 ? <p className="mt-4 text-sm text-market-muted">No merchant had paid orders in this period{q ? " matching your search" : ""}.</p> : (
        <>
          <ul className="mt-4 grid gap-3 md:hidden">
            {sorted.map((r) => (
              <li key={r.merchantId} className="rounded-xl border border-market-line p-4 text-sm">
                <p className="font-black">{r.merchantName}</p>
                <p className="text-xs text-market-muted">{r.merchantId}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                  <dt className="text-market-muted">GMV</dt><dd className="text-right font-bold tabular-nums">{ghs(r.gmv)}</dd>
                  <dt className="text-market-muted">Orders</dt><dd className="text-right tabular-nums">{count(r.orders)}</dd>
                  <dt className="text-market-muted">Refund rate</dt><dd className="text-right tabular-nums">{pct(r.refundRate)}</dd>
                  <dt className="text-market-muted">Cancelled after payment</dt><dd className="text-right tabular-nums">{pct(r.cancellationRate)}</dd>
                  <dt className="text-market-muted">Median delivery</dt><dd className="text-right tabular-nums">{duration(r.medianDeliveryMinutes)}</dd>
                  <dt className="text-market-muted">Open risk flags</dt><dd className="text-right tabular-nums">{count(r.openRiskFlags)}</dd>
                </dl>
              </li>
            ))}
          </ul>
          <div className="mt-4 hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Merchant performance, sortable by column</caption>
              <thead className="text-xs uppercase text-market-muted">
                <tr>
                  {MERCHANT_COLUMNS.map((c) => (
                    <th key={c.key} scope="col" className={`py-2 pr-3 ${c.numeric ? "text-right" : ""}`}
                      aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                      <button type="button" onClick={() => toggle(c.key)} className="font-bold uppercase hover:underline">
                        {c.label}{sort.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.merchantId} className="border-t border-market-line">
                    <th scope="row" className="py-2 pr-3 font-bold">{r.merchantName}<span className="block text-xs font-normal text-market-muted">{r.merchantId}</span></th>
                    <td className="py-2 pr-3 text-right tabular-nums">{count(r.orders)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{ghs(r.gmv)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{pct(r.refundRate)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{pct(r.cancellationRate)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{duration(r.medianDeliveryMinutes)}</td>
                    <td className="py-2 text-right tabular-nums">{r.openRiskFlags ? <strong className="text-market-orange">{count(r.openRiskFlags)}</strong> : "0"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

function CategoryTable({ rows, exporter }: { rows: Report["categories"]; exporter: ReturnType<typeof useExport> }) {
  return (
    <Panel title="Sales by category" intro="Paid orders only, grouped by each product's current category."
      actions={<ExportButton section="categories" label="Download CSV" exporter={exporter} />}>
      {rows.length === 0 ? <p className="mt-4 text-sm text-market-muted">No paid orders in this period.</p> : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Merchandise value and units by category</caption>
            <thead className="text-xs uppercase text-market-muted">
              <tr><th scope="col" className="py-2 pr-3">Category</th><th scope="col" className="py-2 pr-3 text-right">Units</th><th scope="col" className="hidden py-2 pr-3 text-right sm:table-cell">Orders</th><th scope="col" className="py-2 text-right">GMV</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.categoryKey} className="border-t border-market-line">
                  <th scope="row" className="py-2 pr-3 font-bold">{r.categoryName}</th>
                  <td className="py-2 pr-3 text-right tabular-nums">{count(r.units)}</td>
                  <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">{count(r.orders)}</td>
                  <td className="py-2 text-right tabular-nums">{ghs(r.gmv)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
