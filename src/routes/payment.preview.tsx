import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { RedirectToSignIn, SignInGate } from "@/modules/identity/public/auth/gates";
import { completePreviewPayment } from "@/modules/payments/public/payment";

export const Route = createFileRoute("/payment/preview")({ component: PreviewPay });

function PreviewPay() {
  const paymentId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("paymentId") : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!paymentId) return;
    setBusy(true);
    setError(null);
    try {
      await completePreviewPayment({ data: { paymentId } });
      window.location.href = `/payment/return?paymentId=${encodeURIComponent(paymentId)}`;
    } catch {
      setError("We could not confirm the payment preview. Please try again.");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-market-bg px-4 py-16">
    <SignInGate fallback={<RedirectToSignIn />}>
        <div className="mx-auto max-w-lg rounded-3xl border border-market-line bg-white p-8 shadow-market">
          <p className="eyebrow">Preview collection</p>
          <h1 className="mt-2 text-3xl font-black">Confirm demo payment</h1>
          <p className="mt-3 text-sm leading-6 text-market-muted">
            This preview environment settles the order without a live payment network. Production deployments require a configured provider adapter.
          </p>
          <div className="mt-6 flex gap-3 rounded-2xl bg-market-soft p-4 text-sm">
            <ShieldCheck className="shrink-0 text-market-green" />
            <span>No card or mobile money is charged here. The order still moves through inventory and payment state machines; payment collection and settlement remain provider-managed.</span>
          </div>
          {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>}
          <button disabled={busy || !paymentId} onClick={confirm} className="mt-7 h-12 w-full rounded-xl bg-market-orange font-black text-white disabled:opacity-50">
            {busy ? "Confirming…" : "Pay now (preview)"}
          </button>
          <Link to="/checkout" className="mt-4 inline-flex text-sm font-bold text-market-muted">Back to checkout</Link>
        </div>
    </SignInGate>
    </main>
  );
}
