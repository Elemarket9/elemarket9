import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import {
  addAdminOrderInternalNote,
  cancelUnpaidAdminOrder,
  loadAdminOrderDetail,
  revealAdminOrderCustomerContact,
  searchAdminOrderList,
  setAdminOrderDeliveryHold,
  type AdminOrderDetail,
  type AdminOrderListRow,
} from "@/modules/administration/public/transport/admin/orders.functions";
import { formatGhs as ghs, formatDateTime as when } from "@/modules/shared/public/display";

const VIEW = ["admin.orders.view", "admin.orders.manage"];

export const Route = createFileRoute("/admin/orders")({
  head: () => ({ meta: [{ title: "Orders | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  // Only the order ID is ever put in the URL; customer contact filters are sent by POST.
  validateSearch: z.object({ order: z.string().trim().min(1).max(128).optional().catch(undefined) }),
  loaderDeps: ({ search }) => ({ order: search.order }),
  loader: async ({ deps }) => {
    const access = await getAdminAccessState();
    if (!(access.staffRole === "owner" || VIEW.some((c) => access.capabilities.includes(c)))) throw redirect({ to: "/admin" });
    const [initial, detail] = await Promise.all([
      searchAdminOrderList({ data: {} }),
      deps.order ? loadAdminOrderDetail({ data: { orderId: deps.order } }) : Promise.resolve(null),
    ]);
    return { access, initial, detail };
  },
  component: OrdersWorkspace,
  errorComponent: () => (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl font-black">Orders access required</h1>
      <p className="mt-3 text-sm text-market-muted">Ask the Main Administrator for the orders permission.</p>
    </main>
  ),
});

const STATUSES = ["payment_pending", "paid", "confirmed", "fulfilling", "shipped", "delivered", "completed", "cancelled", "disputed", "refund_pending", "refunded"];
const label = (v: string) => v.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
const STATUS_STYLE: Record<string, string> = {
  payment_pending: "bg-amber-50 text-amber-900", cancelled: "bg-market-soft text-market-muted", refunded: "bg-market-soft text-market-muted",
  refund_pending: "bg-amber-50 text-amber-900", disputed: "bg-red-50 text-red-800", delivered: "bg-green-50 text-green-800", completed: "bg-green-50 text-green-800",
};

function errorText(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  if (/fresh/i.test(m)) return "Please sign out and sign in again, then retry. This action needs a recent sign-in.";
  if (/forbidden|permission|admin role required/i.test(m)) return "You don't have the permission this needs.";
  if (/rate|too many/i.test(m)) return "Too many attempts. Wait a few minutes and try again.";
  return m || "That did not work. Please try again.";
}

function StatusPill({ status }: { status: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_STYLE[status] ?? "bg-market-soft text-market-ink"}`}>{label(status)}</span>;
}

function Panel({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6 rounded-2xl border border-market-line bg-white p-5">
      <h2 className="text-xl font-black">{title}</h2>
      {intro ? <p className="mt-1 text-sm text-market-muted">{intro}</p> : null}
      {children}
    </section>
  );
}

type Filters = { orderId: string; email: string; phone: string; merchant: string; status: string; from: string; to: string };
const EMPTY: Filters = { orderId: "", email: "", phone: "", merchant: "", status: "", from: "", to: "" };

function OrdersWorkspace() {
  const { access, initial, detail } = Route.useLoaderData();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<AdminOrderListRow[]>(initial.orders);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [searchError, setSearchError] = useState<string | null>(initial.error);
  const [loading, setLoading] = useState(false);

  async function run(next: Filters, after: string | null) {
    setLoading(true); setSearchError(null);
    try {
      const data = Object.fromEntries(Object.entries(next).filter(([, v]) => v.trim()));
      const result = await searchAdminOrderList({ data: { ...data, cursor: after ?? undefined } });
      if (result.error) { setSearchError(result.error); if (!after) setRows([]); setCursor(null); return; }
      setRows((prev) => (after ? [...prev, ...result.orders] : result.orders));
      setCursor(result.nextCursor);
      setApplied(next);
    } catch (e) { setSearchError(errorText(e)); }
    finally { setLoading(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void run(filters, null); };
  const clear = () => { setFilters(EMPTY); void run(EMPTY, null); };
  const field = (key: keyof Filters) => ({ value: filters[key], onChange: (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [key]: e.target.value })) });
  const input = "mt-1 w-full rounded-xl border border-market-line p-2.5 text-sm font-normal";

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
      <header className="rounded-3xl border border-market-line bg-white p-6">
        <p className="text-xs font-black uppercase tracking-widest text-market-muted">Customer operations</p>
        <h1 className="mt-2 text-3xl font-black">Orders</h1>
        <p className="mt-2 text-sm text-market-muted">
          Find any order and see everything that happened to it. Customer email, phone and full delivery address are hidden unless you reveal them. Searches without filters show the last 7 days; every reveal and action is recorded in the audit history.
        </p>
      </header>

      {detail ? (
        detail.detail ? <OrderDetail detail={detail.detail} canManage={detail.canManage} /> : (
          <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">No order with that ID. <Link to="/admin/orders" search={{}} className="font-bold underline">Back to search</Link></p>
        )
      ) : null}

      <Panel title="Find orders" intro="Exact match on email and phone. Order ID: the full ID or its last 8 characters. Newest orders first.">
        <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm font-bold">Order ID<input {...field("orderId")} maxLength={130} autoComplete="off" className={input} placeholder="e.g. 3f9a12bc" /></label>
          <label className="text-sm font-bold">Customer email<input {...field("email")} type="email" maxLength={254} autoComplete="off" className={input} /></label>
          <label className="text-sm font-bold">Customer phone<input {...field("phone")} type="tel" maxLength={20} autoComplete="off" className={input} placeholder="024 123 4567" /></label>
          <label className="text-sm font-bold">Merchant (ID or name)<input {...field("merchant")} maxLength={120} autoComplete="off" className={input} /></label>
          <label className="text-sm font-bold">Status
            <select {...field("status")} className={input}>
              <option value="">Any status</option>
              {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          </label>
          <label className="text-sm font-bold">Placed from<input {...field("from")} type="date" className={input} /></label>
          <label className="text-sm font-bold">Placed to<input {...field("to")} type="date" className={input} /></label>
          <div className="flex items-end gap-2">
            <button type="submit" disabled={loading} className="rounded-xl bg-market-green px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">{loading ? "Searching…" : "Search"}</button>
            <button type="button" disabled={loading} onClick={clear} className="rounded-xl border border-market-line px-4 py-2.5 text-sm font-bold">Clear</button>
          </div>
        </form>
        {searchError ? <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{searchError}</p> : null}
        <OrderResults rows={rows} />
        {cursor ? (
          <button type="button" disabled={loading} onClick={() => void run(applied, cursor)} className="mt-4 w-full rounded-xl border border-market-line px-4 py-2.5 text-sm font-bold disabled:opacity-50">
            {loading ? "Loading…" : "Show more orders"}
          </button>
        ) : null}
      </Panel>
    </main>
  );
}

function OrderResults({ rows }: { rows: AdminOrderListRow[] }) {
  if (!rows.length) return <p className="mt-4 text-sm text-market-muted">No orders match.</p>;
  const open = (id: string) => ({ to: "/admin/orders" as const, search: { order: id } });
  return (
    <>
      <ul className="mt-4 grid gap-3 md:hidden">
        {rows.map((o) => (
          <li key={o.id}>
            <Link {...open(o.id)} className="block rounded-xl border border-market-line p-4 hover:border-market-green">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-bold">…{o.id.slice(-8)}</span>
                <StatusPill status={o.status} />
              </div>
              <p className="mt-2 text-sm font-bold">{ghs(o.grandTotal)} · {o.merchantName}</p>
              <p className="mt-1 text-xs text-market-muted">{o.customerName ?? "Customer"} · {o.customerEmailMasked ?? "no email"} · {o.customerPhoneMasked ?? "no phone"}</p>
              <p className="mt-1 text-xs text-market-muted">{when(o.createdAt)}{o.holdActive ? " · Delivery on hold" : ""}</p>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-4 hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-market-muted">
            <tr><th className="py-2 pr-3">Order</th><th className="pr-3">Placed</th><th className="pr-3">Customer</th><th className="pr-3">Merchant</th><th className="pr-3">Total</th><th className="pr-3">Status</th><th className="pr-3">Payment</th></tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-t border-market-line align-top">
                <td className="py-2 pr-3"><Link {...open(o.id)} className="font-mono font-bold text-market-green underline">…{o.id.slice(-8)}</Link></td>
                <td className="py-2 pr-3 whitespace-nowrap">{when(o.createdAt)}</td>
                <td className="py-2 pr-3">{o.customerName ?? "—"}<div className="text-xs text-market-muted">{o.customerEmailMasked ?? "—"} · {o.customerPhoneMasked ?? "—"}</div></td>
                <td className="py-2 pr-3">{o.merchantName}</td>
                <td className="py-2 pr-3 whitespace-nowrap">{ghs(o.grandTotal)}</td>
                <td className="py-2 pr-3"><StatusPill status={o.status} />{o.holdActive ? <div className="mt-1 text-xs font-bold text-market-orange">On hold</div> : null}</td>
                <td className="py-2 pr-3 text-xs">{o.paymentStatus ? label(o.paymentStatus) : "—"}{o.paymentTiming === "on_delivery" ? " · on delivery" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OrderDetail({ detail, canManage }: { detail: AdminOrderDetail; canManage: boolean }) {
  const router = useRouter();
  const { order, customer, merchant, items, payment, hold, timeline } = detail;
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [contact, setContact] = useState<{ email: string | null; phone: string | null; accountPhone: string | null; address?: string | null } | null>(null);
  const act = async (key: string, fn: () => Promise<string>, refresh = true) => {
    setBusy(key); setMessage(null);
    try { setMessage({ kind: "ok", text: await fn() }); if (refresh) await router.invalidate(); }
    catch (e) { setMessage({ kind: "error", text: errorText(e) }); }
    finally { setBusy(null); }
  };
  const totals: Array<[string, string]> = [
    ["Products", order.productTotal],
    ...(Number(order.promoDiscount) > 0 ? [["Promotion discount (already deducted)", order.promoDiscount] as [string, string]] : []),
    ["Delivery", order.deliveryTotal],
    ["Grand total (customer paid)", order.grandTotal],
    ["Platform fee", order.platformFee],
    ["Merchant net", order.merchantNet],
  ];

  return (
    <section aria-label="Order detail" className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/admin/orders" search={{}} className="text-sm font-bold text-market-green underline">← Back to search</Link>
        <span className="text-xs text-market-muted">Updated {when(order.updatedAt)}</span>
      </div>
      <div className="mt-3 rounded-2xl border border-market-line bg-white p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-black">Order …{order.id.slice(-8)}</h2>
          <StatusPill status={order.status} />
          {hold?.active ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-900">Delivery on hold</span> : null}
        </div>
        <p className="mt-1 break-all font-mono text-xs text-market-muted">{order.id}</p>
        <p className="mt-1 text-sm text-market-muted">Placed {when(order.createdAt)} · {label(order.deliveryTier)} delivery · {order.paymentTiming === "on_delivery" ? "Pay on delivery" : "Paid upfront"}</p>
      </div>
      {message ? <p role={message.kind === "error" ? "alert" : "status"} className={`mt-4 rounded-xl p-4 text-sm ${message.kind === "error" ? "bg-red-50 text-red-800" : "bg-green-50 text-green-900"}`}>{message.text}</p> : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-market-line bg-white p-5">
          <h3 className="font-black">Customer</h3>
          <p className="mt-2 text-sm font-bold">{customer.name ?? "—"}</p>
          <p className="mt-1 text-sm">{contact ? contact.email ?? "No email" : customer.emailMasked ?? "No email"}</p>
          <p className="text-sm">{contact ? contact.phone ?? "No phone" : customer.phoneMasked ?? "No phone"}</p>
          {contact && contact.accountPhone && contact.accountPhone !== contact.phone ? <p className="text-xs text-market-muted">Account phone: {contact.accountPhone}</p> : null}
          {canManage && !contact ? <RevealContact busy={busy} onReveal={(reason) => act("reveal", async () => {
            setContact(await revealAdminOrderCustomerContact({ data: { orderId: order.id, reason } }));
            return "Contact details shown. This was recorded in the audit history.";
          }, false)} /> : null}
          <h3 className="mt-4 font-black">Delivery address</h3>
          <p className="mt-1 whitespace-pre-line text-sm">{contact?.address ?? order.address}</p>
        </div>
        <div className="rounded-2xl border border-market-line bg-white p-5">
          <h3 className="font-black">Merchant</h3>
          <p className="mt-2 text-sm font-bold">{merchant.name}</p>
          <p className="text-xs text-market-muted">{merchant.id} · {label(merchant.status)}{merchant.city ? ` · ${merchant.city}` : ""}</p>
          <h3 className="mt-4 font-black">Payment</h3>
          <p className="mt-1 text-sm">{payment ? `${label(payment.status)} · ${label(payment.method)} · ${ghs(payment.amount)}` : "No payment record"}</p>
        </div>
        <div className="rounded-2xl border border-market-line bg-white p-5">
          <h3 className="font-black">Totals</h3>
          <dl className="mt-2 grid gap-1 text-sm">
            {totals.map(([k, v]) => <div key={k} className="flex justify-between gap-2"><dt className="text-market-muted">{k}</dt><dd className="font-bold">{ghs(v)}</dd></div>)}
          </dl>
        </div>
      </div>

      <Panel title={`Items (${items.length})`}>
        <ul className="mt-3 grid gap-2 text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap justify-between gap-2 rounded-xl border border-market-line px-3 py-2">
              <span><strong>{i.productName}</strong>{i.variantName ? ` · ${i.variantName}` : ""} <span className="text-market-muted">× {i.quantity} @ {ghs(i.unitPrice)}</span></span>
              <span className="font-bold">{ghs(i.productTotal)}</span>
            </li>
          ))}
        </ul>
      </Panel>

      {canManage ? <OrderActions detail={detail} busy={busy} act={act} /> : null}

      <Panel title="Timeline" intro="Everything recorded about this order, oldest first. Read-only.">
        <ol className="mt-4 grid gap-2">
          {timeline.map((t, idx) => (
            <li key={`${t.at}-${idx}`} className="rounded-xl border border-market-line px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-bold">{t.title}</span>
                <span className="text-xs text-market-muted">{when(t.at)}</span>
              </div>
              {t.detail ? <p className="mt-1 whitespace-pre-line break-words text-market-muted">{t.detail}</p> : null}
              <p className="mt-1 text-xs text-market-muted">{label(t.kind)}{t.actor ? ` · ${t.actor}` : ""}</p>
            </li>
          ))}
        </ol>
      </Panel>
    </section>
  );
}

function RevealContact({ busy, onReveal }: { busy: string | null; onReveal: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="mt-2 rounded-lg border border-market-line px-3 py-1.5 text-xs font-bold">Reveal full contact</button>;
  return (
    <div className="mt-2 grid gap-2">
      <label className="text-xs font-bold">Why do you need it? (recorded)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="mt-1 w-full rounded-lg border border-market-line p-2 text-sm font-normal" placeholder="e.g. Calling customer about failed delivery" />
      </label>
      <button type="button" disabled={busy !== null || reason.trim().length < 8} onClick={() => onReveal(reason.trim())} className="rounded-lg bg-market-green px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
        {busy === "reveal" ? "Revealing…" : "Reveal"}
      </button>
    </div>
  );
}

function OrderActions({ detail, busy, act }: { detail: AdminOrderDetail; busy: string | null; act: (key: string, fn: () => Promise<string>) => Promise<void> }) {
  const { order, actions } = detail;
  const [note, setNote] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const area = "mt-1 w-full rounded-xl border border-market-line p-2.5 text-sm font-normal";
  return (
    <Panel title="Actions" intro="Each action needs a recent sign-in and is recorded in the audit history.">
      <div className="mt-4 grid gap-5 lg:grid-cols-3">
        <div>
          <label className="text-sm font-bold">Add an internal note
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} className={area} placeholder="Visible to staff only. Notes can't be edited or deleted." />
          </label>
          <button type="button" disabled={busy !== null || note.trim().length < 3} onClick={() => void act("note", async () => {
            await addAdminOrderInternalNote({ data: { orderId: order.id, body: note.trim() } }); setNote(""); return "Note added.";
          })} className="mt-2 rounded-xl bg-market-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy === "note" ? "Saving…" : "Add note"}</button>
        </div>

        <div>
          {actions.placeHold || actions.releaseHold ? (
            <>
              <label className="text-sm font-bold">{actions.releaseHold ? "Release the delivery hold" : "Stop delivery (hold)"}
                <textarea value={holdReason} onChange={(e) => setHoldReason(e.target.value)} rows={3} maxLength={1000} className={area}
                  placeholder={actions.releaseHold ? "How you confirmed it is safe to deliver (12+ characters)" : "Why delivery must stop (12+ characters)"} />
              </label>
              <button type="button" disabled={busy !== null || holdReason.trim().length < 12} onClick={() => void act("hold", async () => {
                const action = actions.releaseHold ? "release" : "hold";
                await setAdminOrderDeliveryHold({ data: { orderId: order.id, action, reason: holdReason.trim() } }); setHoldReason("");
                return action === "hold" ? "Delivery is on hold. Riders will not hand it over until it is released." : "Hold released. Delivery can continue.";
              })} className="mt-2 rounded-xl border border-market-line px-4 py-2 text-sm font-bold disabled:opacity-50">
                {busy === "hold" ? "Saving…" : actions.releaseHold ? "Release hold" : "Place hold"}
              </button>
              <p className="mt-1 text-xs text-market-muted">A hold stops the shipment. It never changes the delivery address.</p>
            </>
          ) : <p className="text-sm text-market-muted">Delivery holds are only possible for paid orders that have not been delivered.</p>}
        </div>

        <div>
          {actions.cancelUnpaid ? (
            <>
              <label className="text-sm font-bold">Cancel this unpaid order
                <textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={3} maxLength={1000} className={area} placeholder="Reason (12+ characters). Reserved stock goes back on sale." />
              </label>
              {confirmCancel ? (
                <div className="mt-2 flex gap-2">
                  <button type="button" disabled={busy !== null || cancelReason.trim().length < 12} onClick={() => void act("cancel", async () => {
                    const r = await cancelUnpaidAdminOrder({ data: { orderId: order.id, reason: cancelReason.trim() } });
                    return `Order cancelled. ${r.releasedReservations} stock reservation(s) released.`;
                  })} className="rounded-xl bg-red-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy === "cancel" ? "Cancelling…" : "Yes, cancel order"}</button>
                  <button type="button" onClick={() => setConfirmCancel(false)} className="rounded-xl border border-market-line px-4 py-2 text-sm font-bold">Keep order</button>
                </div>
              ) : (
                <button type="button" disabled={cancelReason.trim().length < 12} onClick={() => setConfirmCancel(true)} className="mt-2 rounded-xl border border-red-300 px-4 py-2 text-sm font-bold text-red-800 disabled:opacity-50">Cancel order…</button>
              )}
            </>
          ) : actions.requestRefund ? (
            <>
              <p className="text-sm font-bold">This order is paid</p>
              <p className="mt-1 text-sm text-market-muted">Paid orders are not cancelled here. Finance staff refund them, with a second approver for large amounts.</p>
              <a href={`/admin/refunds?order=${encodeURIComponent(order.id)}`} className="mt-2 inline-block rounded-xl border border-market-line px-4 py-2 text-sm font-bold text-market-green">Request refund</a>
            </>
          ) : <p className="text-sm text-market-muted">This order can't be cancelled or refunded from here in its current state ({label(order.status)}).</p>}
        </div>
      </div>
    </Panel>
  );
}
