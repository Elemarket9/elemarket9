import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CheckCircle2, Clock3, XCircle } from "lucide-react";
import { createPaymentIntent, getCustomerPaymentStatus } from "@/modules/payments/public/payment";

import { listCustomerPendingPayments } from "@/modules/ordering/public/orders";

export const Route = createFileRoute("/payment/return")({ component: PaymentReturn });

function PaymentReturn() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>("checking");
  const [error, setError] = useState<string | null>(null);
  const paymentId =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("paymentId")
      : null;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function check() {
      if (!paymentId) {
        setStatus("invalid");
        return;
      }
      try {
        const result = await getCustomerPaymentStatus({ data: { paymentId } });
        if (cancelled) return;
        if (result.status === "completed") {
          const raw = localStorage.getItem("elemarket:payment-queue:v1");
          let queue: Array<{ paymentId: string }> = [];
          try {
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            if (Array.isArray(parsed))
              queue = parsed.filter((item): item is { paymentId: string } =>
                Boolean(
                  item &&
                  typeof item === "object" &&
                  typeof (item as { paymentId?: unknown }).paymentId === "string",
                ),
              );
          } catch {
            queue = [];
          }
          const remaining = queue.filter((item) => item.paymentId !== paymentId);
          // The server is authoritative; localStorage is only a UI hint.
          const pending = result.groupId
            ? await listCustomerPendingPayments({ data: { groupId: result.groupId, limit: 30 } })
            : { payments: [] };
          const nextPaymentId = pending.payments.find((p) => p.paymentId !== paymentId)?.paymentId;
          if (nextPaymentId) {
            localStorage.setItem("elemarket:payment-queue:v1", JSON.stringify(remaining));
            const next = await createPaymentIntent({ data: { paymentId: nextPaymentId } });
            if (!next?.checkoutUrl)
              throw new Error("The next payment provider did not return a secure checkout URL.");
            window.location.href = next.checkoutUrl;
            return;
          }
          localStorage.removeItem("elemarket:payment-queue:v1");
          setStatus("completed");
          return;
        }
        if (result.status === "failed" || result.status === "refunded") {
          setStatus(result.status);
          return;
        }
        setStatus("pending");
        timer = window.setTimeout(check, 2500);
      } catch {
        if (!cancelled) {
          setError("Payment status is temporarily unavailable. Please try again.");
          setStatus("error");
        }
      }
    }
    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [paymentId]);

  const title =
    status === "completed"
      ? "Payment confirmed"
      : status === "failed"
        ? "Payment failed"
        : status === "refunded"
          ? "Payment refunded"
          : status === "invalid"
            ? "Invalid payment return"
            : status === "error"
              ? "Payment status unavailable"
              : "Confirming your payment";
  return (
    <main className="min-h-screen bg-market-bg px-4 py-16">
      <div className="mx-auto max-w-xl rounded-3xl border border-market-line bg-white p-8 text-center shadow-market">
        {status === "completed" ? (
          <CheckCircle2 className="mx-auto text-market-green" size={52} />
        ) : status === "failed" ||
          status === "refunded" ||
          status === "invalid" ||
          status === "error" ? (
          <XCircle className="mx-auto text-red-600" size={52} />
        ) : (
          <Clock3 className="mx-auto animate-pulse text-market-orange" size={52} />
        )}
        <h1 className="mt-5 text-3xl font-black">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-market-muted">
          {error ??
            (status === "completed"
              ? "Your payment has been verified by the payment provider."
              : status === "pending" || status === "checking"
                ? "We are waiting for the provider confirmation. Do not pay again while this page is checking."
                : "Please return to your order and try again if needed.")}
        </p>
        <div className="mt-7 flex gap-3 justify-center">
          <Link
            to="/"
            className="rounded-xl bg-market-green px-5 py-3 text-sm font-black text-white"
          >
            Marketplace
          </Link>
          {status !== "completed" && (
            <button
              onClick={() => navigate({ to: "/checkout" })}
              className="rounded-xl border border-market-line px-5 py-3 text-sm font-black"
            >
              Back to checkout
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
