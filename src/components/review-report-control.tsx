import { useId, useState, type FormEvent } from "react";
import { Flag } from "lucide-react";
import { reportReview } from "@/modules/engagement/public/transport/review-reports.functions";
import {
  REVIEW_MODERATION_REASONS,
  REVIEW_MODERATION_REASON_LABELS,
  REVIEW_REPORT_NOTE_MAX,
  type ReviewModerationReason,
} from "@/modules/engagement/public/review-moderation.shared";

function friendlyError(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  if (/own review/i.test(m)) return "You can't report your own review.";
  if (/no longer available/i.test(m)) return "This review is no longer available.";
  if (/rate|too many/i.test(m)) return "You've sent a lot of reports recently. Please try again later.";
  if (/unauthor|sign in|role/i.test(m)) return "Please sign in with a customer account to report a review.";
  return "We couldn't send your report. Please try again.";
}

/** Small "Report" control for one review. Render only for signed-in customers. */
export function ReviewReportControl({ reviewId }: { reviewId: string }) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReviewModerationReason | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (done) {
    return <p role="status" className="mt-3 text-xs font-semibold text-market-green">Thanks for letting us know. Our team will review it.</p>;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason) return;
    setBusy(true); setError(null);
    try {
      await reportReview({ data: { reviewId, reason, note: note.trim() || undefined } });
      setDone(true);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} aria-expanded={false} aria-controls={formId}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-market-muted hover:bg-market-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-market-green">
          <Flag className="h-3.5 w-3.5" aria-hidden="true" /> Report<span className="sr-only"> this review</span>
        </button>
      ) : (
        <form id={formId} onSubmit={submit} className="space-y-2 rounded-xl bg-market-soft p-3" aria-label="Report this review">
          <label className="block text-xs font-bold">What's wrong with this review?
            <select required value={reason} onChange={(e) => setReason(e.target.value as ReviewModerationReason)}
              className="mt-1 h-10 w-full rounded-lg border border-market-line bg-white px-2 text-sm font-normal">
              <option value="" disabled>Choose a reason</option>
              {REVIEW_MODERATION_REASONS.map((r) => <option key={r} value={r}>{REVIEW_MODERATION_REASON_LABELS[r]}</option>)}
            </select>
          </label>
          <label className="block text-xs font-bold">Anything else? <span className="font-normal text-market-muted">(optional)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={REVIEW_REPORT_NOTE_MAX} rows={2}
              className="mt-1 w-full rounded-lg border border-market-line bg-white p-2 text-sm font-normal" />
          </label>
          {error ? <p role="alert" className="text-xs font-semibold text-red-700">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !reason} className="rounded-lg bg-market-green px-3 py-2 text-xs font-black text-white disabled:opacity-50">
              {busy ? "Sending…" : "Send report"}
            </button>
            <button type="button" onClick={() => { setOpen(false); setError(null); }} className="rounded-lg border border-market-line bg-white px-3 py-2 text-xs font-bold">Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
