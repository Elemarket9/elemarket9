import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { completePreviewFinancingDeposit } from "@/modules/financing/public/financing-form";
export const Route = createFileRoute("/financing/deposit-preview")({
  validateSearch: (search: Record<string, unknown>) => ({
    depositPaymentId: typeof search.depositPaymentId === "string" ? search.depositPaymentId : "",
  }),
  component: DepositPreview,
});
function DepositPreview() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = Route.useSearch().depositPaymentId;
  async function complete() {
    setBusy(true);
    setError(null);
    try {
      await completePreviewFinancingDeposit({ data: { depositPaymentId: id } });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete preview deposit");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="grid min-h-screen place-items-center bg-market-bg px-4">
      <section className="w-full max-w-md rounded-3xl border bg-white p-8 text-center">
        <p className="text-xs font-black uppercase text-market-muted">ELEMARKET preview</p>
        <h1 className="mt-3 text-3xl font-black">Financing initial deposit</h1>
        <p className="mt-3 text-sm text-market-muted">
          This preview simulates the payment provider confirming the financing provider's initial
          deposit. It does not mark the merchandise order paid.
        </p>
        {error ? (
          <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>
        ) : null}
        {done ? (
          <>
            <p className="mt-5 rounded-xl bg-green-50 p-3 text-sm font-bold text-green-800">
              Preview deposit confirmed.
            </p>
            <Link
              to="/"
              className="mt-4 inline-flex rounded-xl bg-black px-5 py-3 font-black text-white"
            >
              Return to marketplace
            </Link>
          </>
        ) : (
          <button
            disabled={busy || !id}
            onClick={() => void complete()}
            className="mt-6 h-12 w-full rounded-xl bg-black font-black text-white disabled:opacity-50"
          >
            {busy ? "Confirming…" : "Complete preview deposit"}
          </button>
        )}
      </section>
    </main>
  );
}
