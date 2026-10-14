import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { requestAdminProviderRefund } from "@/modules/administration/public/transport/admin/dashboard.functions";

export const Route = createFileRoute("/admin/refunds")({
  head: () => ({ meta: [{ title: "Authorized refund operations | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  loader: async () => {
    const access = await getAdminAccessState();
    if (!(access.staffRole === "owner" || access.capabilities.includes("admin.finance.refunds"))) {
      throw redirect({ to: "/admin" });
    }
    return { access };
  },
  component: RefundWorkspace,
});

function RefundWorkspace() {
  const { access } = Route.useLoaderData();
  const [orderId, setOrderId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!orderId.trim() || note.trim().length < 12) { setError("Specify the order and a documented decision reason (12+ characters)."); return; }
    setBusy(true);setError(null);setNotice(null);
    try {
      // Backend applies fresh-session checks, authorization, ordering locks,
      // audit records and provider-specific execution through neutral contracts.
      await requestAdminProviderRefund({ data: { orderId: orderId.trim(), note: note.trim() } });
      setNotice("Refund request processed by the server. Verify its reconciliation state before telling the customer that funds have returned.");
    } catch (e) { setError(e instanceof Error ? e.message : "Refund request failed"); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-4xl px-4 py-8"><AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
    <header className="rounded-3xl border border-market-line bg-white p-6"><h1 className="text-3xl font-black">Authorized refund requests</h1>
      <p className="mt-2 text-sm text-market-muted">Only delegated finance staff with refund authority can use this action. A request is not proof the customer has received funds. Never mark a refund successful before the payment provider confirms it.</p></header>
    {notice && <p role="status" className="mt-5 rounded-xl bg-green-50 p-4 text-sm text-green-900">{notice}</p>}
    {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">{error}</p>}
    <section className="mt-6 rounded-2xl border border-market-line bg-white p-6">
      <label className="block text-sm font-bold">Order ID<input value={orderId} onChange={e => setOrderId(e.target.value)} maxLength={128} autoComplete="off" className="mt-2 w-full rounded-xl border p-3" /></label>
      <label className="mt-4 block text-sm font-bold">Documented refund justification<textarea value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={2000} className="mt-2 w-full rounded-xl border p-3" /></label>
      <button type="button" disabled={busy || !orderId.trim() || note.trim().length < 12} onClick={() => void submit()} className="mt-5 rounded-xl bg-market-green px-6 py-3 font-bold text-white disabled:opacity-50">{busy ? "Submitting…" : "Request provider refund"}</button>
    </section>
  </main>;
}
