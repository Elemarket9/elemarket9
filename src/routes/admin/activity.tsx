import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { loadAdminAuditHistory, type AdminActivityRow } from "@/modules/administration/public/transport/admin/audit.functions";
export const Route=createFileRoute("/admin/activity")({
 head:()=>({meta:[{title:"Admin activity history | ELEMARKET"},{name:"robots",content:"noindex,nofollow,noarchive"}]}),
 loader:async()=>{
   const access=await getAdminAccessState();
   if(!(access.staffRole==="owner"||access.capabilities.includes('admin.audit.read')))throw redirect({to:"/admin"});
   return {rows:await loadAdminAuditHistory({data:{}}),access};
 },component:Activity,
});
function Activity(){
 const {rows:initial,access}=Route.useLoaderData();
 const [rows,setRows]=useState<AdminActivityRow[]>(initial);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState<string|null>(null);
 const [canLoadMore,setCanLoadMore]=useState(initial.length===100);
 async function more(){const last=rows.at(-1);if(!last)return;setLoading(true);setError(null);
   try{const next=await loadAdminAuditHistory({data:{beforeId:last.id}});setRows(r=>[...r,...next]);setCanLoadMore(next.length===100)}
   catch{setError("Could not load older audit records.")}finally{setLoading(false)}
 }
 return <main className="mx-auto max-w-7xl px-4 py-8"><AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} /><nav className="mb-4 flex gap-4 text-sm font-bold"><a href="/admin" className="text-market-green">← Administrator home</a>{(access.staffRole==="owner" || access.capabilities.includes("admin.staff.directory")) && <a href="/admin/team" className="text-market-green">Staff access</a>}</nav>
   <section className="rounded-3xl border border-market-line bg-white p-6"><p className="text-xs font-black uppercase tracking-widest text-market-muted">Security & accountability</p><h1 className="mt-2 text-3xl font-black">Administrative activity history</h1><p className="mt-2 text-sm text-market-muted">Read-only record of actor, action, resource, outcome and UTC time. Audit metadata is intentionally not exposed here because it may contain sensitive data. Events are append-only in the database.</p></section>
   {error&&<p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
   <section className="mt-6 overflow-x-auto rounded-2xl border border-market-line bg-white"><table className="w-full min-w-[760px] text-left text-sm"><caption className="sr-only">Recorded administrative and system activity</caption><thead className="bg-market-soft text-xs uppercase text-market-muted"><tr><th scope="col" className="p-3">UTC time</th><th scope="col" className="p-3">Actor</th><th scope="col" className="p-3">Action</th><th scope="col" className="p-3">Resource</th><th scope="col" className="p-3">Outcome</th></tr></thead><tbody>{rows.map(r=><tr key={r.id} className="border-t border-market-line"><td className="p-3 whitespace-nowrap">{r.createdAt}</td><td className="p-3 break-all">{r.actorId??r.actorRole??"system"}</td><td className="p-3 font-semibold">{r.eventType}</td><td className="p-3">{r.resourceType} · {r.resourceId??"—"}</td><td className="p-3">{r.outcome}</td></tr>)}</tbody></table>{rows.length===0&&<p className="p-6 text-sm text-market-muted">No audit records available.</p>}</section>
   {canLoadMore&&<button onClick={()=>void more()} type="button" disabled={loading} className="mt-5 rounded-xl border border-market-line bg-white px-5 py-3 text-sm font-bold disabled:opacity-40">{loading?"Loading…":"Load older activity"}</button>}
 </main>;
}
