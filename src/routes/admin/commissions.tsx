import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { loadCommissionPolicy, setGlobalCommissionRule } from "@/modules/administration/public/transport/admin/fee.functions";

export const Route = createFileRoute("/admin/commissions")({
  head: () => ({ meta: [{ title: "Commission policy | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  loader: async () => {
    const access = await getAdminAccessState();
    if (!(access.staffRole === "owner" || access.capabilities.includes("admin.finance.view") || access.capabilities.includes("admin.finance.policy"))) {
      throw redirect({ to: "/admin" });
    }
    const policy = await loadCommissionPolicy();
    return { policy, access };
  },
  component: CommissionWorkspace,
});

function CommissionWorkspace() {
  const { policy, access } = Route.useLoaderData();
  const canChange = access.staffRole === "owner" || access.capabilities.includes("admin.finance.policy");
  const [percent, setPercent] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function saveGlobal() {
    const ratePercent = Number(percent);
    if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100 || reason.trim().length < 12) {
      setMessage("Enter a valid percentage (0–100) and a documented decision reason (12+ characters)."); return;
    }
    setBusy(true);setMessage(null);
    try {
      await setGlobalCommissionRule({data:{ratePercent,active:true,reason:reason.trim()}});
      window.location.reload();
    } catch (e) { setMessage(e instanceof Error ? e.message : "The policy change was rejected"); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-6xl px-4 py-8"><AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
    <header className="rounded-3xl border border-market-line bg-white p-6"><p className="text-xs font-black uppercase tracking-widest text-market-muted">Financial operations</p><h1 className="mt-2 text-3xl font-black">Commission policy</h1><p className="mt-2 text-sm text-market-muted">Authorized finance staff may review commission rules. Editing requires a separate delegated policy permission and a recorded rationale. Existing marketplace payment providers remain independent.</p></header>
    {message && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-700">{message}</p>}
    <section className="mt-6 rounded-2xl border border-market-line bg-white p-5"><h2 className="text-xl font-black">Current rules</h2>
      <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="bg-market-soft"><th className="p-3">Scope</th><th className="p-3">ID</th><th className="p-3">Rate</th><th className="p-3">Status</th></tr></thead><tbody>{policy.rules.map(rule => <tr key={rule.id} className="border-t"><td className="p-3">{rule.scopeType}</td><td className="p-3">{rule.scopeId ?? "All"}</td><td className="p-3">{rule.ratePercent}%</td><td className="p-3">{rule.active ? "Active" : "Inactive"}</td></tr>)}</tbody></table></div>
    </section>
    {canChange && <section className="mt-6 rounded-2xl border border-market-line bg-white p-5"><h2 className="text-xl font-black">Change global commission</h2>
      <p className="mt-1 text-sm text-market-muted">This is a sensitive marketplace policy. Every change is server-authorized and transactionally audited.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-sm font-bold">New rate (%)<input inputMode="decimal" value={percent} onChange={e => setPercent(e.target.value)} className="mt-1 block w-full rounded-xl border p-3" placeholder="e.g. 7.50" /></label>
      <label className="text-sm font-bold">Decision justification<input value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} className="mt-1 block w-full rounded-xl border p-3" placeholder="Policy review and approval record" /></label></div>
      <button disabled={busy} onClick={() => void saveGlobal()} type="button" className="mt-4 rounded-xl bg-market-green px-5 py-3 text-sm font-black text-white disabled:opacity-50">{busy ? "Saving…" : "Apply audited commission policy"}</button>
    </section>}
  </main>;
}
