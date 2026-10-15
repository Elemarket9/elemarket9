import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  getCustomerFinancingDepositStatus,
  resumeCustomerFinancingDeposit,
  retryCustomerFinancingDeposit,
} from "@/modules/financing/public/financing-form";
export const Route = createFileRoute("/financing/deposit-return")({
  validateSearch: (search: Record<string, unknown>) => ({
    depositPaymentId: typeof search.depositPaymentId === "string" ? search.depositPaymentId : "",
  }),
  component: DepositReturn,
});
function DepositReturn() {
  const id = Route.useSearch().depositPaymentId;
  const [status, setStatus] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function poll() {
      try {
        const s = await getCustomerFinancingDepositStatus({ data: { depositPaymentId: id } });
        if (!active) return;
        setStatus(s);
        if (!["completed", "failed", "refunded"].includes(s.status))
          timer = window.setTimeout(poll, 2000);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not verify deposit");
      }
    }
    if (id) void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [id]);
  return (
    <main className="grid min-h-screen place-items-center bg-market-bg px-4">
      <section className="w-full max-w-lg rounded-3xl border bg-white p-8 text-center">
        <p className="text-xs font-black uppercase text-market-muted">Financing provider deposit</p>
        <h1 className="mt-3 text-3xl font-black">
          {status?.status === "completed" ? "Deposit confirmed" : "Confirming your deposit"}
        </h1>
        <p className="mt-3 text-sm text-market-muted">
          {status?.status === "completed"
            ? "The financing provider has received confirmation of your initial deposit. Your financing application remains subject to that provider's review and terms."
            : "We are waiting for the payment provider's verified confirmation. You can safely leave this page and return later."}
        </p>
        {status ? (
          <p className="mt-4 rounded-xl bg-market-soft p-3 text-sm font-black">
            GHS {Number(status.amount).toFixed(2)} · {status.status}
          </p>
        ) : null}
        {error ? (
          <p className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>
        ) : null}
        {status && ["initiated", "authorized"].includes(status.status) ? (
          <button
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void resumeCustomerFinancingDeposit({ data: { depositPaymentId: id } })
                .then((r: any) => {
                  if (r.checkoutUrl) window.location.href = r.checkoutUrl;
                  else setError("Deposit checkout is initializing. Try again shortly.");
                })
                .catch((e) =>
                  setError(e instanceof Error ? e.message : "Could not continue deposit"),
                )
                .finally(() => setRetrying(false));
            }}
            className="mt-5 rounded-xl bg-market-green px-5 py-3 font-black text-white disabled:opacity-50"
          >
            {retrying ? "Opening…" : "Continue initial deposit"}
          </button>
        ) : null}
        {status?.status === "failed" ? (
          <button
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void retryCustomerFinancingDeposit({ data: { depositPaymentId: id } })
                .then((r: any) => {
                  if (r.checkoutUrl) window.location.href = r.checkoutUrl;
                  else setError("Deposit retry is initializing. Refresh shortly.");
                })
                .catch((e) => setError(e instanceof Error ? e.message : "Could not retry deposit"))
                .finally(() => setRetrying(false));
            }}
            className="mt-5 rounded-xl bg-market-green px-5 py-3 font-black text-white disabled:opacity-50"
          >
            {retrying ? "Retrying…" : "Retry initial deposit"}
          </button>
        ) : null}
        <Link
          to="/"
          className="mt-6 ml-2 inline-flex rounded-xl bg-black px-5 py-3 font-black text-white"
        >
          Return to marketplace
        </Link>
      </section>
    </main>
  );
}
