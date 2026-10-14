import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { loadEnterpriseMerchantCandidates, setMerchantEnterpriseMode } from "@/modules/administration/public/transport/admin/moderation.functions";

export const Route = createFileRoute("/admin/enterprise")({
  head: () => ({ meta: [{ title: "Enterprise merchant operations | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  loader: async () => {
    const access = await getAdminAccessState();
    if (!(access.staffRole === "owner" || access.capabilities.includes("admin.enterprise.manage"))) throw redirect({ to: "/admin" });
    return { access, merchants: await loadEnterpriseMerchantCandidates() };
  },
  component: EnterpriseOperations,
});
function EnterpriseOperations() {
  const { access, merchants } = Route.useLoaderData();
  const [reasons, setReasons] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState<string|null>(null);
  const [error, setError] = useState<string|null>(null);
  async function toggle(id:string,enable:boolean) {
    const reason=reasons[id]?.trim()??"";
    if (reason.length < 12) { setError("Explain the enterprise-governance decision in at least 12 characters.");return; }
    setError(null);setBusy(id);
    try { await setMerchantEnterpriseMode({data:{merchantId:id,action:enable ? 'enable':'disable',reason}});window.location.reload(); }
    catch(e){setError(e instanceof Error ? e.message : 'Enterprise action failed');}
    finally{setBusy(null);}
  }
  return <main className="mx-auto max-w-6xl px-4 py-8"><AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
    <header className="rounded-3xl border border-market-line bg-white p-6"><h1 className="text-3xl font-black">Enterprise merchant governance</h1>
      <p className="mt-2 text-sm text-market-muted">Delegated enterprise managers may enable or suspend enterprise mode. All changes require server permission, an authenticated administrator, audit evidence and the merchant's required approval prerequisites.</p></header>
    {error&&<p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">{error}</p>}
    <section className="mt-6 space-y-3" aria-label="Enterprise merchants">{merchants.map(m => <article key={m.id} className="rounded-xl border border-market-line bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-black">{m.name}</h2><p className="text-xs text-market-muted">{m.tier} · {m.catalogSource} · {m.status} · {m.verified ? 'Verified' : 'Not verified'}</p></div>
        <span className="text-xs font-bold">Merchant {m.id}</span></div>
      <label className="mt-3 block text-sm font-semibold">Governance decision reason<input value={reasons[m.id]??''} onChange={e=>setReasons(x=>({...x,[m.id]:e.target.value}))} maxLength={2000} className="mt-1 w-full rounded-xl border p-3" /></label>
      <button type="button" disabled={busy!==null || (m.tier!=='enterprise' && (m.status!=='active'||!m.verified))} className="mt-3 rounded-lg border border-market-line px-4 py-2 text-sm font-bold disabled:opacity-50" onClick={()=>void toggle(m.id,m.tier!=='enterprise')}>{busy===m.id?'Updating…':m.tier==='enterprise'?'Disable enterprise mode':'Enable enterprise mode'}</button>
    </article>)}{merchants.length===0&&<p className="rounded-xl bg-white p-5 text-sm text-market-muted">No merchants are available for enterprise review.</p>}</section>
  </main>;
}
