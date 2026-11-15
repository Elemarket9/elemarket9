import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import {
  dismissReviewReportsAdmin,
  hideReviewAdmin,
  loadReviewModerationQueue,
  restoreReviewAdmin,
} from "@/modules/engagement/public/transport/admin/review-moderation.functions";
import {
  REVIEW_MODERATION_NOTE_MAX,
  REVIEW_MODERATION_REASONS,
  REVIEW_MODERATION_REASON_LABELS,
  type ReviewModerationReason,
} from "@/modules/engagement/public/review-moderation.shared";
import { formatDateTime as when } from "@/modules/shared/public/display";

const PAGE = 50;

export const Route = createFileRoute("/admin/reviews")({
  head: () => ({ meta: [{ title: "Product reviews | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  loader: async () => {
    const access = await getAdminAccessState();
    if (!(access.staffRole === "owner" || access.capabilities.includes("admin.reviews.moderate"))) throw redirect({ to: "/admin" });
    const queue = await loadReviewModerationQueue({ data: { status: "all", limit: PAGE, offset: 0 } });
    return { access, queue };
  },
  component: Reviews,
  errorComponent: () => (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl font-black">Review moderation access required</h1>
      <p className="mt-3 text-sm text-market-muted">Ask the Main Administrator for the “moderate product reviews” permission.</p>
    </main>
  ),
});

type Queue = Awaited<ReturnType<typeof loadReviewModerationQueue>>;
type Item = Queue["items"][number];
type Filters = { status: "all" | "reported" | "published" | "hidden"; rating: string; lowStar: boolean; productId: string; merchantId: string };

const reasonLabel = (r: string | null) => (r ? REVIEW_MODERATION_REASON_LABELS[r as ReviewModerationReason] ?? r : "—");

function errorText(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  if (/fresh/i.test(m)) return "For safety, please sign out and sign in again, then retry.";
  if (/forbidden|permission/i.test(m)) return "You don't have the permission this needs.";
  if (/rate|too many/i.test(m)) return "Too many changes in a short time. Wait a few minutes and try again.";
  return m || "That did not work. Please try again.";
}

function Reviews() {
  const { access, queue: initial } = Route.useLoaderData();
  const [queue, setQueue] = useState<Queue>(initial);
  const [filters, setFilters] = useState<Filters>({ status: "all", rating: "", lowStar: false, productId: "", merchantId: "" });
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = async (f: Filters, nextOffset: number) => {
    setLoading(true);
    try {
      const q = await loadReviewModerationQueue({ data: {
        status: f.status,
        rating: f.rating ? Number(f.rating) : undefined,
        lowStar: f.lowStar || undefined,
        productId: f.productId.trim() || undefined,
        merchantId: f.merchantId.trim() || undefined,
        limit: PAGE, offset: nextOffset,
      } });
      setQueue(q); setOffset(nextOffset);
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setLoading(false);
    }
  };

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setMessage(null);
    let ok = false;
    try { setMessage({ kind: "ok", text: await fn() }); ok = true; await load(filters, offset); }
    catch (e) { if (!ok) setMessage({ kind: "error", text: errorText(e) }); }
    finally { setBusy(null); }
    return ok;
  };

  const s = queue.summary;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
      <header className="rounded-3xl border border-market-line bg-white p-6">
        <p className="text-xs font-black uppercase tracking-widest text-market-muted">Trust & safety</p>
        <h1 className="mt-2 text-3xl font-black">Product reviews</h1>
        <p className="mt-2 text-sm text-market-muted">
          Reviews go live straight away. Hide a review only when it breaks the rules — never because it is negative.
          Hidden reviews disappear from the shop and from star ratings, and every decision is recorded in the audit history.
          Merchants can reply to reviews but cannot hide them.
        </p>
        <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
          <div className="rounded-xl bg-market-soft p-3"><dt className="text-xs text-market-muted">Reported, waiting</dt><dd className="text-2xl font-black">{s.openReportedReviews}</dd></div>
          <div className="rounded-xl bg-market-soft p-3"><dt className="text-xs text-market-muted">Hidden</dt><dd className="text-2xl font-black">{s.hiddenReviews}</dd></div>
          <div className="rounded-xl bg-market-soft p-3"><dt className="text-xs text-market-muted">1–2 stars (30 days)</dt><dd className="text-2xl font-black">{s.lowStarLast30Days}</dd></div>
        </dl>
      </header>

      <form className="mt-5 grid gap-3 rounded-2xl border border-market-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-6"
        onSubmit={(e) => { e.preventDefault(); void load(filters, 0); }} aria-label="Filter reviews">
        <label className="text-sm font-bold">Show
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters["status"] })} className="mt-1 h-10 w-full rounded-xl border border-market-line px-2 font-normal">
            <option value="all">All (reported first)</option>
            <option value="reported">Reported only</option>
            <option value="published">Visible</option>
            <option value="hidden">Hidden</option>
          </select>
        </label>
        <label className="text-sm font-bold">Stars
          <select value={filters.rating} onChange={(e) => setFilters({ ...filters, rating: e.target.value })} className="mt-1 h-10 w-full rounded-xl border border-market-line px-2 font-normal">
            <option value="">Any</option>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n > 1 ? "s" : ""}</option>)}
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm font-bold">
          <input type="checkbox" checked={filters.lowStar} onChange={(e) => setFilters({ ...filters, lowStar: e.target.checked })} /> Only 1–2 stars
        </label>
        <label className="text-sm font-bold">Product ID
          <input value={filters.productId} onChange={(e) => setFilters({ ...filters, productId: e.target.value })} maxLength={128} className="mt-1 h-10 w-full rounded-xl border border-market-line px-2 font-normal" />
        </label>
        <label className="text-sm font-bold">Merchant ID
          <input value={filters.merchantId} onChange={(e) => setFilters({ ...filters, merchantId: e.target.value })} maxLength={128} className="mt-1 h-10 w-full rounded-xl border border-market-line px-2 font-normal" />
        </label>
        <div className="flex items-end">
          <button type="submit" disabled={loading} className="h-10 w-full rounded-xl bg-market-green px-4 text-sm font-black text-white disabled:opacity-50">{loading ? "Loading…" : "Apply"}</button>
        </div>
      </form>

      {message ? (
        <p role={message.kind === "error" ? "alert" : "status"} className={`mt-5 rounded-xl p-4 text-sm ${message.kind === "error" ? "bg-red-50 text-red-800" : "bg-green-50 text-green-900"}`}>{message.text}</p>
      ) : null}

      <section className="mt-5" aria-busy={loading}>
        {queue.items.length ? (
          <ul className="grid gap-3">
            {queue.items.map((item) => <ReviewCard key={item.id} item={item} busy={busy} run={run} />)}
          </ul>
        ) : <p className="rounded-2xl border border-market-line bg-white p-6 text-sm text-market-muted">No reviews match these filters.</p>}
        <div className="mt-4 flex justify-between gap-3">
          <button type="button" disabled={loading || offset === 0} onClick={() => void load(filters, Math.max(0, offset - PAGE))} className="rounded-xl border border-market-line bg-white px-4 py-2 text-sm font-bold disabled:opacity-40">Previous</button>
          <button type="button" disabled={loading || !queue.hasMore} onClick={() => void load(filters, offset + PAGE)} className="rounded-xl border border-market-line bg-white px-4 py-2 text-sm font-bold disabled:opacity-40">Next</button>
        </div>
      </section>
    </main>
  );
}

type Run = (key: string, fn: () => Promise<string>) => Promise<boolean>;

function ReviewCard({ item, busy, run }: { item: Item; busy: string | null; run: Run }) {
  const [mode, setMode] = useState<"none" | "hide" | "restore" | "dismiss">("none");
  const [reason, setReason] = useState<ReviewModerationReason | "">((Object.keys(item.openReasons)[0] as ReviewModerationReason | undefined) ?? "");
  const [note, setNote] = useState("");
  const hidden = item.status === "hidden";
  const disabled = busy !== null;
  const reasons = Object.entries(item.openReasons) as Array<[ReviewModerationReason, number]>;

  return (
    <li className={`rounded-2xl border bg-white p-4 ${item.openReports > 0 ? "border-amber-300" : "border-market-line"} ${hidden ? "opacity-90" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-black"><span aria-label={`${item.rating} out of 5 stars`}>{"★".repeat(item.rating)}<span className="text-market-line">{"★".repeat(5 - item.rating)}</span></span> · {item.productName}</p>
          <p className="text-xs text-market-muted">{item.merchantName} · {when(item.createdAt)} · product {item.productId} · merchant {item.merchantId}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-bold">
          {item.openReports > 0 ? <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-900">{item.openReports} open report{item.openReports > 1 ? "s" : ""}</span> : null}
          <span className={`rounded-full px-2 py-1 ${hidden ? "bg-red-50 text-red-800" : "bg-green-50 text-green-800"}`}>{hidden ? "Hidden" : "Visible"}</span>
        </div>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{item.body}</p>
      {item.merchantResponse ? <p className="mt-2 rounded-xl bg-market-soft p-3 text-sm"><strong>Merchant reply:</strong> {item.merchantResponse}</p> : null}
      {reasons.length ? (
        <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm">
          <p className="font-bold">Why customers reported it</p>
          <ul className="mt-1 list-disc pl-5">{reasons.map(([r, n]) => <li key={r}>{reasonLabel(r)} × {n}</li>)}</ul>
          {item.reportNotes.length ? <ul className="mt-2 space-y-1 text-xs text-market-muted">{item.reportNotes.map((n, i) => <li key={i} className="break-words">“{n}”</li>)}</ul> : null}
        </div>
      ) : null}
      {hidden ? (
        <p className="mt-3 text-sm text-market-muted">Hidden by {item.moderatedByName ?? "an administrator"} on {when(item.moderatedAt)} — <strong>{reasonLabel(item.hiddenReason)}</strong>{item.hiddenNote ? `: “${item.hiddenNote}”` : ""}</p>
      ) : null}

      {mode === "none" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {hidden
            ? <button type="button" disabled={disabled} onClick={() => setMode("restore")} className="rounded-xl border border-market-line px-4 py-2 text-sm font-bold disabled:opacity-50">Restore review</button>
            : <button type="button" disabled={disabled} onClick={() => setMode("hide")} className="rounded-xl border border-red-200 px-4 py-2 text-sm font-bold text-red-800 disabled:opacity-50">Hide review</button>}
          {item.openReports > 0 ? <button type="button" disabled={disabled} onClick={() => setMode("dismiss")} className="rounded-xl border border-market-line px-4 py-2 text-sm font-bold disabled:opacity-50">Dismiss reports</button> : null}
        </div>
      ) : (
        <form className="mt-3 grid gap-2 rounded-xl border border-market-line p-3" onSubmit={(e) => {
          e.preventDefault();
          const action = mode === "hide"
            ? (reason ? async () => { await hideReviewAdmin({ data: { reviewId: item.id, reason, note } }); return "Review hidden. It no longer shows in the shop or star ratings."; } : null)
            : mode === "restore"
              ? async () => { await restoreReviewAdmin({ data: { reviewId: item.id, note } }); return "Review restored and visible again."; }
              : async () => { const r = await dismissReviewReportsAdmin({ data: { reviewId: item.id, note: note.trim() || undefined } }); return `${r.dismissed} report${r.dismissed > 1 ? "s" : ""} dismissed. The review stays visible.`; };
          if (action) void run(item.id, action).then((ok) => { if (ok) { setMode("none"); setNote(""); } });
        }}>
          {mode === "hide" ? (
            <label className="text-sm font-bold">Reason
              <select required value={reason} onChange={(e) => setReason(e.target.value as ReviewModerationReason)} className="mt-1 h-10 w-full rounded-xl border border-market-line px-2 font-normal">
                <option value="" disabled>Choose a reason</option>
                {REVIEW_MODERATION_REASONS.map((r) => <option key={r} value={r}>{REVIEW_MODERATION_REASON_LABELS[r]}</option>)}
              </select>
            </label>
          ) : null}
          <label className="text-sm font-bold">{mode === "dismiss" ? "Note (optional)" : "Note for the record (required)"}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={mode === "dismiss" ? 500 : REVIEW_MODERATION_NOTE_MAX}
              className="mt-1 w-full rounded-xl border border-market-line p-2 font-normal"
              placeholder={mode === "hide" ? "e.g. Contains the reviewer's phone number" : mode === "restore" ? "e.g. Reviewed again; complaint is genuine product feedback" : "e.g. Negative but honest product feedback"} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={disabled || (mode !== "dismiss" && note.trim().length < 5) || (mode === "hide" && !reason)}
              className={`rounded-xl px-4 py-2 text-sm font-black text-white disabled:opacity-50 ${mode === "hide" ? "bg-red-700" : "bg-market-green"}`}>
              {busy === item.id ? "Saving…" : mode === "hide" ? "Hide review" : mode === "restore" ? "Restore review" : "Dismiss reports"}
            </button>
            <button type="button" onClick={() => { setMode("none"); setNote(""); }} className="rounded-xl border border-market-line px-4 py-2 text-sm font-bold">Cancel</button>
          </div>
        </form>
      )}
    </li>
  );
}
