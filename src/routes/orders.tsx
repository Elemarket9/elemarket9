import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowRight, Package, RotateCcw } from "lucide-react";
import { listCustomerOrders } from "@/modules/ordering/public/orders";
import { SignInGate } from "@/modules/identity/public/auth/gates";
import { useCurrentUserState } from "@/modules/identity/public/auth/use-current-user";
import { formatGhs } from "@/modules/shared/public/money";
import { MarketFooter, MarketHeader } from "@/components/market-header";
import { ContactSupportWidget } from "@/components/contact-support-widget";

export const Route = createFileRoute("/orders")({
  head: () => ({ meta: [{ title: "My orders | ELEMARKET" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: Orders,
});
type OrderSummary = Awaited<ReturnType<typeof listCustomerOrders>>["orders"][number];
function statusLabel(status: string) { return status.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase()); }

function Orders() {
  const { user, isPending } = useCurrentUserState();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (isPending || !user) return;
    let active = true;
    setBusy(true); setError(null); setMoreError(null);
    void listCustomerOrders({ data: { limit: 20 } }).then(r => { if (!active) return; setOrders(r.orders); setNext(r.nextCursor); })
      .catch(() => { if (active) setError("Orders could not be loaded. Please try again."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [isPending, user, retry]);

  return <div className="min-h-screen bg-market-bg">
    <MarketHeader /><ContactSupportWidget mode="order" />
    <main id="main-content" className="mx-auto max-w-[1100px] px-4 py-8 sm:px-6 lg:px-8">
      <nav aria-label="Breadcrumb" className="text-xs font-semibold text-market-muted"><Link to="/" className="hover:text-market-green">Shop</Link> <span aria-hidden="true">/</span> My orders</nav>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">Your account</p><h1 className="section-title">Orders & deliveries</h1><p className="mt-2 text-sm text-market-muted">Track purchases, provider delivery updates, disputes and refunds.</p></div><Link to="/" className="market-btn-secondary">Continue shopping <ArrowRight size={16} aria-hidden="true" /></Link></div>
      <SignInGate fallback={<div className="market-card mt-8 p-8"><h2 className="text-xl font-black">Sign in to view your orders</h2><p className="mt-2 text-sm text-market-muted">Your order history is available only to your account.</p><Link to="/login" className="market-btn-primary mt-5">Sign in</Link></div>}>
        <section aria-label="Order history" className="mt-7 space-y-3">
          {busy && <div role="status" className="market-card p-8 text-sm text-market-muted">Loading your orders…</div>}
          {error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-5"><p className="text-sm font-semibold text-red-800">{error}</p><button type="button" onClick={() => setRetry(v => v + 1)} className="market-btn-secondary mt-3"><RotateCcw size={15} aria-hidden="true" /> Retry</button></div>}
          {!busy && !error && !orders.length && <div className="market-card p-10 text-center"><div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-market-soft text-market-green"><Package size={28} aria-hidden="true"/></div><h2 className="mt-4 text-xl font-black">No orders yet</h2><p className="mt-2 text-sm text-market-muted">When you order, your purchases and delivery updates will appear here.</p><Link to="/" className="market-btn-primary mt-5">Browse products</Link></div>}
          {orders.map(o => <Link key={o.id} to="/orders/$id" params={{ id: o.id }} className="market-card block p-5 transition hover:border-market-green/30 hover:shadow-market-lg sm:p-6"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="text-[11px] font-extrabold uppercase tracking-widest text-market-muted">Order</p><p className="mt-1 break-all text-sm font-bold text-market-ink">{o.id}</p><time className="mt-1 block text-xs text-market-muted" dateTime={o.createdAt}>{new Date(o.createdAt).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" })}</time></div><span className="rounded-full bg-market-soft px-3 py-1.5 text-xs font-black text-market-green">{statusLabel(o.status)}</span></div><div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-market-line pt-4"><div><p className="text-xs text-market-muted">Order total</p><p className="mt-1 text-xl font-black">{formatGhs(Number(o.grandTotal))}</p></div>{o.disputeStatus && <p className="text-xs text-market-muted">Dispute: <strong className="text-market-ink">{statusLabel(o.disputeStatus)}</strong></p>}<span className="inline-flex items-center gap-1 text-sm font-black text-market-green">View order <ArrowRight size={15} aria-hidden="true" /></span></div></Link>)}
          {moreError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">{moreError}</p>}
          {next && !error && <button type="button" disabled={loadingMore} onClick={async () => { if (!next) return; setLoadingMore(true); setMoreError(null); try { const r = await listCustomerOrders({ data: { limit: 20, cursor: next } }); setOrders(v => [...v, ...r.orders]); setNext(r.nextCursor); } catch { setMoreError("More orders could not be loaded. Select Load more orders to retry."); } finally { setLoadingMore(false); } }} className="market-btn-secondary mx-auto flex">{loadingMore ? "Loading orders…" : "Load more orders"}</button>}
        </section>
      </SignInGate>
    </main><MarketFooter />
  </div>;
}
