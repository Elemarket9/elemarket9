import { createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { z } from "zod";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { moderateCustomer, moderateMerchant } from "@/modules/administration/public/transport/admin/moderation.functions";
import {
  claimRiskFlagForReview,
  decideRiskFlagReview,
  getRiskFlag,
  listRiskQueue,
  releaseRiskFlagClaim,
} from "@/modules/administration/public/transport/admin/risk.functions";
import {
  RISK_CLAIM_TTL_MINUTES,
  RISK_DECISION_LABELS,
  RISK_NOTE_MAX,
  RISK_NOTE_MIN,
  RISK_SEVERITIES,
  decisionLabel,
  flagCodeLabel,
  type RiskDecision,
  type RiskEvidenceEntry,
} from "@/modules/administration/public/risk-review-format";
import { formatGhs as ghs, formatDateTime as when } from "@/modules/shared/public/display";

const search = z.object({
  view: z.enum(["queue", "history"]).optional(),
  severity: z.enum(RISK_SEVERITIES).optional(),
  subject: z.enum(["customer", "merchant"]).optional(),
  code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
  outcome: z.enum(["resolved", "dismissed"]).optional(),
  flag: z.string().regex(/^rf_[a-f0-9]{32}$/).optional(),
});

export const Route = createFileRoute("/admin/risk")({
  head: () => ({ meta: [{ title: "Fraud & risk review | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  validateSearch: search,
  loaderDeps: ({ search: s }) => s,
  loader: async ({ deps }) => {
    const access = await getAdminAccessState();
    const owner = access.staffRole === "owner" || access.capabilities.includes("admin.full");
    if (!(owner || access.capabilities.includes("admin.risk.review"))) throw redirect({ to: "/admin" });
    const history = deps.view === "history";
    const [queue, detail] = await Promise.all([
      listRiskQueue({ data: {
        status: history ? deps.outcome ?? "decided" : "open",
        severity: deps.severity ?? null, subjectType: deps.subject ?? null, flagCode: deps.code ?? null, limit: 100,
      } }),
      deps.flag ? getRiskFlag({ data: { flagId: deps.flag } }).catch(() => null) : Promise.resolve(null),
    ]);
    const can = (cap: string) => owner || access.capabilities.includes(cap);
    return {
      access, queue, detail,
      can: { moderateCustomers: can("admin.customers.moderate"), moderateMerchants: can("admin.merchants.moderate") },
    };
  },
  component: RiskReview,
  errorComponent: () => (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl font-black">Risk review access required</h1>
      <p className="mt-3 text-sm text-market-muted">Ask the Main Administrator for the fraud and risk review permission.</p>
    </main>
  ),
});

type Queue = Awaited<ReturnType<typeof listRiskQueue>>;
type Flag = Queue["flags"][number];
type Detail = Awaited<ReturnType<typeof getRiskFlag>>;
type Can = { moderateCustomers: boolean; moderateMerchants: boolean };
type Run = (key: string, fn: () => Promise<string>) => Promise<void>;

const time = (v: string | null) => (v ? new Date(v).toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" }) : "—");
const age = (v: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(v)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
};

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-600 text-white", high: "bg-red-50 text-red-800", medium: "bg-amber-50 text-amber-900", low: "bg-market-soft text-market-muted",
};
const DECISION_STYLE: Record<string, string> = {
  confirmed_fraud: "bg-red-50 text-red-800", confirmed_monitor: "bg-amber-50 text-amber-900", dismissed_false_positive: "bg-market-soft text-market-muted",
};
const EVENT_LABEL: Record<string, string> = {
  "admin.risk_flag.claimed": "Claimed", "admin.risk_flag.released": "Released", "admin.risk_flag.decided": "Decided",
};

function errorText(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  if (/fresh/i.test(m)) return "Please sign in again before making review decisions.";
  if (/rate|too many/i.test(m)) return "Too many actions in a short time. Wait a few minutes and try again.";
  if (/forbidden|permission/i.test(m)) return "You don't have the permission this needs.";
  return m || "That did not work. Please try again.";
}

function Pill({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${className}`}>{children}</span>;
}

function subjectLine(f: Flag) {
  const name = f.subject.name ?? (f.subjectType === "customer" ? "Unknown customer" : "Unknown merchant");
  const extra = f.subjectType === "customer" ? f.subject.maskedEmail : null;
  return `${f.subjectType === "customer" ? "Customer" : "Merchant"}: ${name}${extra ? ` · ${extra}` : ""}`;
}

function claimText(f: Flag, viewerId: string) {
  if (f.status !== "open") return null;
  if (!f.claimActive) return "Unclaimed";
  return f.assignedTo === viewerId ? `You, until ${time(f.claimExpiresAt)}` : `${f.assigneeName ?? "Another reviewer"}, until ${time(f.claimExpiresAt)}`;
}

function RiskReview() {
  const data = Route.useLoaderData();
  const { access, can } = data;
  const queue: Queue = data.queue;
  const detail: Detail | null = data.detail;
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const history = s.view === "history";

  const run: Run = async (key, fn) => {
    setBusy(key); setMessage(null);
    try { setMessage({ kind: "ok", text: await fn() }); await router.invalidate(); }
    catch (e) { setMessage({ kind: "error", text: errorText(e) }); }
    finally { setBusy(null); }
  };
  const setSearch = (patch: Partial<typeof s>) => void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  const open = (id: string) => setSearch({ flag: id });

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
      <header className="rounded-3xl border border-market-line bg-white p-6">
        <p className="text-xs font-black uppercase tracking-widest text-market-muted">Trust & safety</p>
        <h1 className="mt-2 text-3xl font-black">Fraud & risk review</h1>
        <p className="mt-2 text-sm text-market-muted">
          Flags raised automatically by checkout and merchant fund-release risk checks. Claim a flag so nobody else works on it
          (claims last {RISK_CLAIM_TTL_MINUTES} minutes), look at the evidence, then dismiss or confirm it with a note.
          A decision is a record only: it does not suspend anyone or hold any order.
        </p>
      </header>

      {message ? (
        <p role={message.kind === "error" ? "alert" : "status"} className={`mt-5 rounded-xl p-4 text-sm ${message.kind === "error" ? "bg-red-50 text-red-800" : "bg-green-50 text-green-900"}`}>{message.text}</p>
      ) : null}

      <nav aria-label="Review views" className="mt-6 flex flex-wrap gap-2">
        {([["queue", "Open queue"], ["history", "Decided flags"]] as const).map(([v, label]) => (
          <button key={v} type="button" aria-pressed={(history ? "history" : "queue") === v}
            className={`rounded-xl px-4 py-2 text-sm font-black ${(history ? "history" : "queue") === v ? "bg-market-green text-white" : "border border-market-line bg-white"}`}
            onClick={() => setSearch({ view: v === "queue" ? undefined : v, outcome: undefined, flag: undefined })}>{label}</button>
        ))}
      </nav>

      <section aria-label="Filters" className="mt-4 grid gap-3 rounded-2xl border border-market-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-bold">Severity
          <select value={s.severity ?? ""} onChange={(e) => setSearch({ severity: (e.target.value || undefined) as typeof s.severity, flag: undefined })} className="mt-1 w-full rounded-xl border border-market-line p-2">
            <option value="">Any</option>
            {RISK_SEVERITIES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="text-sm font-bold">Who
          <select value={s.subject ?? ""} onChange={(e) => setSearch({ subject: (e.target.value || undefined) as typeof s.subject, flag: undefined })} className="mt-1 w-full rounded-xl border border-market-line p-2">
            <option value="">Customers and merchants</option>
            <option value="customer">Customers</option>
            <option value="merchant">Merchants</option>
          </select>
        </label>
        <label className="text-sm font-bold">Flag type
          <select value={s.code ?? ""} onChange={(e) => setSearch({ code: e.target.value || undefined, flag: undefined })} className="mt-1 w-full rounded-xl border border-market-line p-2">
            <option value="">Any</option>
            {queue.flagCodes.map((c) => <option key={c} value={c}>{flagCodeLabel(c)}</option>)}
          </select>
        </label>
        {history ? (
          <label className="text-sm font-bold">Outcome
            <select value={s.outcome ?? ""} onChange={(e) => setSearch({ outcome: (e.target.value || undefined) as typeof s.outcome, flag: undefined })} className="mt-1 w-full rounded-xl border border-market-line p-2">
              <option value="">Confirmed or dismissed</option>
              <option value="resolved">Confirmed</option>
              <option value="dismissed">Dismissed</option>
            </select>
          </label>
        ) : null}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-label={history ? "Decided flags" : "Open flags"} className="min-w-0">
          <h2 className="text-xl font-black">{history ? `Decided flags (${queue.flags.length})` : `Open flags (${queue.flags.length})`}</h2>
          {!history ? <p className="mt-1 text-sm text-market-muted">Most severe first, then oldest first.</p> : null}
          {queue.flags.length ? (
            history ? <HistoryList flags={queue.flags} selected={s.flag} open={open} /> : <QueueList flags={queue.flags} viewerId={queue.viewerId} selected={s.flag} open={open} />
          ) : <p className="mt-4 rounded-2xl border border-market-line bg-white p-5 text-sm text-market-muted">{history ? "No decided flags match these filters." : "Nothing is waiting for review."}</p>}
        </section>
        <section aria-label="Flag details" className="min-w-0">
          {detail ? (
            <DetailPanel key={detail.id + detail.status + (detail.assignedTo ?? "")} d={detail} viewerId={queue.viewerId}
              viewerIsOwner={queue.viewerIsOwner} can={can} busy={busy} run={run} close={() => setSearch({ flag: undefined })} />
          ) : (
            <p className="rounded-2xl border border-dashed border-market-line bg-white p-5 text-sm text-market-muted">
              {s.flag ? "That flag could not be loaded." : "Choose a flag to see its evidence and decide it."}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function QueueList({ flags, viewerId, selected, open }: { flags: Flag[]; viewerId: string; selected?: string; open: (id: string) => void }) {
  return (
    <>
      {/* Mobile: cards */}
      <ul className="mt-4 grid gap-3 md:hidden">
        {flags.map((f) => (
          <li key={f.id}>
            <button type="button" onClick={() => open(f.id)} aria-current={selected === f.id}
              className={`w-full rounded-2xl border bg-white p-4 text-left ${selected === f.id ? "border-market-green shadow-market" : "border-market-line"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-black">{flagCodeLabel(f.flagCode)}</span>
                <Pill className={SEVERITY_STYLE[f.severity] ?? ""}>{f.severity}</Pill>
              </div>
              <p className="mt-1 text-sm">{subjectLine(f)}</p>
              <p className="mt-1 text-xs text-market-muted">
                Raised {age(f.createdAt)} ago{f.occurrenceCount > 1 ? ` · seen ${f.occurrenceCount} times` : ""} · {f.related.openOrders} open orders
                {f.related.otherOpenFlags ? ` · ${f.related.otherOpenFlags} other open flags` : ""}
              </p>
              <p className="mt-1 text-xs font-bold">{claimText(f, viewerId)}</p>
            </button>
          </li>
        ))}
      </ul>
      {/* md+: table */}
      <div className="mt-4 hidden overflow-x-auto rounded-2xl border border-market-line bg-white md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-market-soft text-xs uppercase text-market-muted">
            <tr><th className="p-3">Severity</th><th className="p-3">Flag</th><th className="p-3">Subject</th><th className="p-3">Age</th><th className="p-3">Claim</th></tr>
          </thead>
          <tbody>
            {flags.map((f) => (
              <tr key={f.id} className={`cursor-pointer border-t border-market-line ${selected === f.id ? "bg-green-50" : "hover:bg-market-soft"}`} onClick={() => open(f.id)}>
                <td className="p-3"><Pill className={SEVERITY_STYLE[f.severity] ?? ""}>{f.severity}</Pill></td>
                <td className="p-3">
                  <button type="button" className="text-left font-bold underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); open(f.id); }}>{flagCodeLabel(f.flagCode)}</button>
                  {f.occurrenceCount > 1 ? <span className="block text-xs text-market-muted">seen {f.occurrenceCount} times</span> : null}
                </td>
                <td className="p-3">
                  <span className="block">{f.subject.name ?? "—"}</span>
                  <span className="block text-xs text-market-muted">{f.subjectType}{f.subject.maskedEmail ? ` · ${f.subject.maskedEmail}` : ""} · {f.related.openOrders} open orders</span>
                </td>
                <td className="p-3 text-xs">{age(f.createdAt)}</td>
                <td className="p-3 text-xs">{claimText(f, viewerId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function HistoryList({ flags, selected, open }: { flags: Flag[]; selected?: string; open: (id: string) => void }) {
  return (
    <ul className="mt-4 grid gap-3">
      {flags.map((f) => (
        <li key={f.id}>
          <button type="button" onClick={() => open(f.id)} aria-current={selected === f.id}
            className={`w-full rounded-2xl border bg-white p-4 text-left ${selected === f.id ? "border-market-green shadow-market" : "border-market-line"}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-black">{flagCodeLabel(f.flagCode)}</span>
              {f.decision ? <Pill className={DECISION_STYLE[f.decision] ?? ""}>{decisionLabel(f.decision)}</Pill> : <Pill className="bg-market-soft text-market-muted">{f.status}</Pill>}
            </div>
            <p className="mt-1 text-sm">{subjectLine(f)}</p>
            <p className="mt-1 text-xs text-market-muted">By <strong>{f.resolverName ?? f.resolvedBy ?? "—"}</strong> on {when(f.resolvedAt)}</p>
            {f.resolutionNote ? <p className="mt-1 text-sm">“{f.resolutionNote}”</p> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function EvidenceList({ entries }: { entries: RiskEvidenceEntry[] }) {
  if (!entries.length) return <p className="mt-2 text-sm text-market-muted">No evidence was recorded.</p>;
  // Plain text nodes only; evidence is never rendered as HTML.
  return (
    <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
      {entries.map((e) => (
        <div key={e.key} className="contents">
          <dt className="font-bold text-market-muted">{e.label}</dt>
          <dd className="break-words">{e.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailPanel({ d, viewerId, viewerIsOwner, can, busy, run, close }: {
  d: Detail; viewerId: string; viewerIsOwner: boolean; can: Can; busy: string | null; run: Run; close: () => void;
}) {
  const mine = d.claimActive && d.assignedTo === viewerId;
  const otherHolds = d.claimActive && d.assignedTo !== viewerId;
  const canDecide = d.status === "open" && (mine || viewerIsOwner);
  return (
    <article className="rounded-2xl border border-market-line bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-market-muted">Flag {d.id.slice(-8)}</p>
          <h2 className="text-xl font-black">{flagCodeLabel(d.flagCode)}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Pill className={SEVERITY_STYLE[d.severity] ?? ""}>{d.severity}</Pill>
          <button type="button" onClick={close} className="rounded-xl border border-market-line px-3 py-1 text-xs font-bold">Close</button>
        </div>
      </div>

      <dl className="mt-3 grid gap-1 text-sm">
        <div><dt className="inline font-bold">{d.subjectType === "customer" ? "Customer" : "Merchant"}: </dt><dd className="inline">{d.subject.name ?? "Unknown"}{d.subject.maskedEmail ? ` · ${d.subject.maskedEmail}` : ""}{d.subject.status ? ` · status ${d.subject.status}` : ""}</dd></div>
        <div><dt className="inline font-bold">ID: </dt><dd className="inline break-all">{d.subjectId}</dd></div>
        <div><dt className="inline font-bold">Raised: </dt><dd className="inline">{when(d.createdAt)}{d.occurrenceCount > 1 ? ` · seen ${d.occurrenceCount} times, last ${when(d.lastSeenAt)}` : ""}</dd></div>
        <div><dt className="inline font-bold">Open orders: </dt><dd className="inline">{d.related.openOrders}</dd></div>
      </dl>

      <h3 className="mt-5 font-black">Evidence</h3>
      <EvidenceList entries={d.evidence} />
      {d.latestEvidence && d.occurrenceCount > 1 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-bold">Most recent occurrence</summary>
          <EvidenceList entries={d.latestEvidence} />
        </details>
      ) : null}

      {d.status === "open" ? (
        <section className="mt-5 rounded-xl bg-market-soft p-4">
          <h3 className="font-black">Review</h3>
          {mine ? (
            <p className="mt-1 text-sm">You are reviewing this flag until {time(d.claimExpiresAt)}.</p>
          ) : otherHolds ? (
            <p className="mt-1 text-sm"><strong>{d.assigneeName ?? "Another reviewer"}</strong> is reviewing this flag until {time(d.claimExpiresAt)}.</p>
          ) : (
            <p className="mt-1 text-sm">Nobody is reviewing this flag{d.assignedTo ? " (the last claim expired)" : ""}.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {!otherHolds ? (
              <button type="button" disabled={busy !== null} className="rounded-xl bg-market-green px-4 py-2 text-sm font-black text-white disabled:opacity-50"
                onClick={() => void run(`claim${d.id}`, async () => { await claimRiskFlagForReview({ data: { flagId: d.id } }); return mine ? "Claim extended." : "Flag claimed. Nobody else can decide it while your claim lasts."; })}>
                {mine ? `Extend claim (${RISK_CLAIM_TTL_MINUTES} min)` : "Claim for review"}
              </button>
            ) : null}
            {d.assignedTo && (mine || viewerIsOwner) ? (
              <button type="button" disabled={busy !== null} className="rounded-xl border border-market-line bg-white px-4 py-2 text-sm font-black disabled:opacity-50"
                onClick={() => void run(`release${d.id}`, async () => { await releaseRiskFlagClaim({ data: { flagId: d.id } }); return "Flag returned to the queue."; })}>Release</button>
            ) : null}
          </div>
          {canDecide ? <DecisionForm d={d} ownerOverride={!mine} busy={busy} run={run} /> : null}
        </section>
      ) : (
        <section className="mt-5 rounded-xl bg-market-soft p-4">
          <h3 className="font-black">Decision</h3>
          <p className="mt-1 text-sm">
            {d.decision ? <Pill className={DECISION_STYLE[d.decision] ?? ""}>{decisionLabel(d.decision)}</Pill> : d.status}
            {" "}by <strong>{d.resolverName ?? d.resolvedBy ?? "—"}</strong> on {when(d.resolvedAt)}
          </p>
          {d.resolutionNote ? <p className="mt-2 text-sm">“{d.resolutionNote}”</p> : null}
          <p className="mt-2 text-xs text-market-muted">Decisions are final and cannot be edited. If this happens again, a new flag will be raised.</p>
        </section>
      )}

      {d.decision === "confirmed_fraud" ? <ModerationActions d={d} can={can} busy={busy} run={run} /> : null}

      {d.subjectType === "customer" ? (
        <section className="mt-5">
          <h3 className="font-black">This customer's open orders ({d.openOrders.length})</h3>
          {d.openOrders.length ? (
            <ul className="mt-2 grid gap-2 text-sm">
              {d.openOrders.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-market-line px-3 py-2">
                  <a className="font-bold underline underline-offset-2" href={`/admin/orders?order=${encodeURIComponent(o.id)}`}>{o.id}</a>
                  <span className="text-xs text-market-muted">{o.status.replaceAll("_", " ")} · {ghs(o.grandTotal)} · {o.merchantName ?? "—"} · {when(o.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-sm text-market-muted">No open orders.</p>}
        </section>
      ) : null}

      {d.otherFlags.length ? (
        <section className="mt-5">
          <h3 className="font-black">Other flags on this {d.subjectType}</h3>
          <ul className="mt-2 grid gap-1 text-sm">
            {d.otherFlags.map((f) => (
              <li key={f.id} className="flex flex-wrap justify-between gap-2">
                <span>{flagCodeLabel(f.flagCode)} · {f.severity}</span>
                <span className="text-xs text-market-muted">{decisionLabel(f.decision) ?? f.status} · {when(f.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.history.length ? (
        <section className="mt-5">
          <h3 className="font-black">Activity</h3>
          <ol className="mt-2 grid gap-1 text-xs text-market-muted">
            {d.history.map((h, i) => <li key={`${h.at}${i}`}>{when(h.at)} · {EVENT_LABEL[h.eventType] ?? h.eventType} by {h.actorName ?? h.actorId ?? "system"}</li>)}
          </ol>
        </section>
      ) : null}
    </article>
  );
}

function DecisionForm({ d, ownerOverride, busy, run }: { d: Detail; ownerOverride: boolean; busy: string | null; run: Run }) {
  const [decision, setDecision] = useState<RiskDecision | null>(null);
  const [note, setNote] = useState("");
  const valid = decision !== null && note.trim().length >= RISK_NOTE_MIN;
  return (
    <form className="mt-4 grid gap-3" onSubmit={(e) => {
      e.preventDefault();
      if (!decision || !valid) return;
      void run(`decide${d.id}`, async () => {
        await decideRiskFlagReview({ data: { flagId: d.id, decision, note } });
        return decision === "confirmed_fraud"
          ? "Recorded as fraud. Nobody has been suspended; use the moderation actions below if needed."
          : "Decision recorded.";
      });
    }}>
      {ownerOverride ? <p className="text-xs text-market-muted">As Main Administrator you can decide without claiming. This is recorded as an override.</p> : null}
      <fieldset className="grid gap-2">
        <legend className="text-sm font-bold">Decision</legend>
        {(["dismissed_false_positive", "confirmed_monitor", "confirmed_fraud"] as const).map((v) => (
          <label key={v} className="flex items-center gap-2 text-sm">
            <input type="radio" name={`decision-${d.id}`} value={v} checked={decision === v} onChange={() => setDecision(v)} />
            {RISK_DECISION_LABELS[v]}
          </label>
        ))}
      </fieldset>
      <label className="text-sm font-bold">What you checked and why (required, {RISK_NOTE_MIN}+ characters)
        <textarea value={note} onChange={(e) => setNote(e.target.value)} minLength={RISK_NOTE_MIN} maxLength={RISK_NOTE_MAX} rows={3}
          className="mt-1 w-full rounded-xl border border-market-line bg-white p-2 font-normal" placeholder="e.g. Called the customer; the orders are for a church event and payments match" />
      </label>
      <button type="submit" disabled={busy !== null || !valid} className="rounded-xl bg-market-green px-4 py-2 text-sm font-black text-white disabled:opacity-50">Record decision</button>
    </form>
  );
}

function ModerationActions({ d, can, busy, run }: { d: Detail; can: Can; busy: string | null; run: Run }) {
  const [reason, setReason] = useState("");
  const customer = d.subjectType === "customer";
  const allowed = customer ? can.moderateCustomers : can.moderateMerchants;
  const already = customer ? d.subject.status === "blacklisted" : d.subject.status === "suspended";
  return (
    <section className="mt-5 rounded-xl border border-red-200 bg-red-50/40 p-4">
      <h3 className="font-black">Next step: stop the account?</h3>
      <p className="mt-1 text-sm">Confirming fraud did not suspend anyone. {customer ? "Blacklisting the customer" : "Suspending the merchant"} is a separate moderation action.</p>
      {already ? (
        <p className="mt-2 text-sm font-bold">This {customer ? "customer is already blacklisted" : "merchant is already suspended"}.</p>
      ) : allowed ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={1900} aria-label="Reason for the moderation action"
            placeholder="Reason (10+ characters)" className="min-w-0 flex-1 rounded-xl border border-market-line bg-white p-2 text-sm" />
          <button type="button" disabled={busy !== null || reason.trim().length < 10} className="rounded-xl bg-red-700 px-4 py-2 text-sm font-black text-white disabled:opacity-50"
            onClick={() => void run(`moderate${d.id}`, async () => {
              const text = `${reason.trim()} [risk flag ${d.id}]`;
              if (customer) { await moderateCustomer({ data: { userId: d.subjectId, action: "blacklist", reason: text } }); return "Customer blacklisted."; }
              await moderateMerchant({ data: { merchantId: d.subjectId, action: "suspend", reason: text } });
              return "Merchant suspended.";
            })}>{customer ? "Blacklist customer" : "Suspend merchant"}</button>
        </div>
      ) : (
        <p className="mt-2 text-sm text-market-muted">You don't have the {customer ? "customer" : "merchant"} moderation permission. Ask an administrator who does.</p>
      )}
    </section>
  );
}
