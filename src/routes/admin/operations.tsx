import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { reviewMerchantApplication } from "@/modules/merchants/public/transport/admin/merchant-review.functions";
import { setCatalogTaxonomyState } from "@/modules/administration/public/transport/admin/dashboard.functions";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { loadAdminModeration, loadAdminOperationsQueues, moderateMerchant, moderateCustomer, moderateProduct } from "@/modules/administration/public/transport/admin/moderation.functions";

export const Route = createFileRoute("/admin/operations")({
  head: () => ({meta:[{title:"Marketplace moderation | ELEMARKET"},{name:"robots",content:"noindex,nofollow,noarchive"}]}),
  loader: async()=>{
    const access=await getAdminAccessState();
    const can=(permission:string)=>access.staffRole === "owner" || access.capabilities.includes(permission);
    const canModerate=['admin.merchants.moderate','admin.customers.moderate','admin.products.moderate'].some(can);
    const canReview=['admin.merchants.review','admin.categories.manage'].some(can);
    if (!access.authenticated || !access.isAdmin || (!canModerate && !canReview)) throw redirect({to:"/admin"});
    const [moderation,queues]=await Promise.all([
      canModerate ? loadAdminModeration() : Promise.resolve({merchants:[],customers:[],products:[]}),
      canReview ? loadAdminOperationsQueues() : Promise.resolve({applications:[],categories:[]}),
    ]);
    return {moderation,queues,staffRole:access.staffRole,capabilities:access.capabilities};
  },
  component: Operations,
});
function Operations(){
  const {moderation,queues,staffRole,capabilities}=Route.useLoaderData();
  const can=(cap:string)=>staffRole === 'owner' || capabilities.includes(cap);
  const [locations,setLocations]=useState<Record<string,{enabled:boolean;latitude:string;longitude:string;city:string;neighborhood:string;justification:string}>>({});
  const [categoryReasons,setCategoryReasons]=useState<Record<string,string>>({});
  const [reasons,setReasons]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState<string|null>(null);const [error,setError]=useState<string|null>(null);
  const input=(key:string)=><label className="block text-xs font-bold">Decision justification<input aria-label={`Decision reason for ${key}`} value={reasons[key]??""} onChange={e=>setReasons(m=>({...m,[key]:e.target.value}))} maxLength={2000} minLength={10} placeholder="Explain supporting evidence and decision" className="mt-1 w-full rounded-xl border border-market-line p-2 text-sm font-medium" /></label>;
  async function take(key:string,work:(reason:string)=>Promise<unknown>){
    const reason=reasons[key]?.trim()??"";
    if(reason.length<10){setError("All moderation actions require a documented reason of at least 10 characters.");return;}
    setBusy(key);setError(null);
    try{await work(reason);window.location.reload()}catch(e){setError(e instanceof Error?e.message:"Moderation action failed")}finally{setBusy(null)}
  }
  async function applicationDecision(id:string,action:"start_review"|"approve"|"reject"){
    const reason=reasons[`application:${id}`]?.trim()??"";
    if(action!=="start_review"&&reason.length<12){setError("Approval and rejection require a documented reason (12+ characters).");return;}
    const input=locations[id];
    let manualLocation: {latitude:number;longitude:number;city:string;neighborhood:string;justification:string}|undefined;
    if(action==="approve"&&input?.enabled){
      manualLocation={latitude:Number(input.latitude),longitude:Number(input.longitude),city:input.city.trim(),
        neighborhood:input.neighborhood.trim(),justification:input.justification.trim()};
      if(!input.latitude.trim()||!input.longitude.trim()||manualLocation.latitude<4.5||manualLocation.latitude>11.3||
        manualLocation.longitude< -3.3||manualLocation.longitude>1.3||!Number.isFinite(manualLocation.latitude)||
        !Number.isFinite(manualLocation.longitude)||manualLocation.city.length<2||manualLocation.neighborhood.length<2||
        manualLocation.justification.length<15){setError("Manually verified Ghanaian location and a 15-character justification are required.");return;}
    }
    setBusy(`application:${id}`);setError(null);
    try {await reviewMerchantApplication({data:{applicationId:id,action,reason:reason||undefined,manualLocation}});window.location.reload();}
    catch(e){setError(e instanceof Error?e.message:"Could not complete merchant review");}finally{setBusy(null);}
  }
  async function categoryDecision(categoryKey:string,subcategoryKey:string|null,active:boolean){
    const key=categoryKey+(subcategoryKey?`:${subcategoryKey}`:"");
    const reason=categoryReasons[key]?.trim()??"";
    if(reason.length<5){setError("Catalogue changes require a reason of at least 5 characters.");return;}
    setBusy(`category:${key}`);setError(null);
    try{await setCatalogTaxonomyState({data:{scope:subcategoryKey?"subcategory":"category",categoryKey,
      subcategoryKey,active,reason}});window.location.reload();}
    catch(e){setError(e instanceof Error?e.message:"Category update failed");}finally{setBusy(null);}
  }
  return <main className="mx-auto max-w-7xl px-4 py-8"><AdminWorkspaceNav staffRole={staffRole} capabilities={capabilities} />
    <nav className="mb-4 flex flex-wrap gap-4 text-sm font-bold" aria-label="Admin workspaces"><a href="/admin" className="text-market-green">← Administrator home</a>{staffRole==="owner"&&<a href="/admin/dashboard" className="text-market-green">Owner dashboard</a>}{can("admin.support") && <a href="/admin/support" className="text-market-green">Support inbox</a>}</nav>
    <section className="rounded-3xl border border-market-line bg-white p-6"><p className="text-xs font-black uppercase tracking-widest text-market-muted">Operations control</p><h1 className="mt-2 text-3xl font-black">Marketplace moderation queue</h1><p className="mt-2 text-sm text-market-muted">Decisions are server-authorized, must include evidence, and are written to the immutable audit trail. Lists show the most recent 100 records in each category.</p></section>
    {error&&<p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    {can('admin.merchants.review') && <section id="merchant-application-queue" className="mt-6 rounded-2xl border border-market-line bg-white p-5">
      <h2 className="text-xl font-black">Merchant applications · {queues.applications.length} awaiting review</h2>
      <p className="mt-1 text-sm text-market-muted">Application reviews connect directly to merchant activation. An email and phone must be verified before approval. Automated KYB assists decisions but cannot automatically approve merchants.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">{queues.applications.map(a=><article key={a.id} className="rounded-xl border border-market-line p-4">
        <h3 className="font-bold">{a.businessName}</h3><p className="text-xs text-market-muted">{a.status} · Submitted {a.createdAt} UTC</p>
        <p className="mt-2 text-xs">Catalogues: {a.categories.join(", ")||"Pending"}</p>
        <p className="mt-2 text-xs font-semibold">Email: {a.emailVerified?"Verified":"Pending"} · Phone: {a.phoneVerified?"Verified":"Pending"}</p>
        {input(`application:${a.id}`)}
        {a.status==="reviewing"&&<div className="mt-3 rounded-lg bg-market-soft p-3 text-xs">
          <label className="flex items-center gap-2 font-bold"><input type="checkbox" checked={locations[a.id]?.enabled??false} onChange={e=>setLocations(m=>({...m,[a.id]:{enabled:e.target.checked,latitude:m[a.id]?.latitude??"",longitude:m[a.id]?.longitude??"",city:m[a.id]?.city??"",neighborhood:m[a.id]?.neighborhood??"",justification:m[a.id]?.justification??""}}))}/>Use independently verified map coordinates if automatic location fails</label>
          {locations[a.id]?.enabled&&<div className="mt-2 grid gap-2 sm:grid-cols-2">{(["latitude","longitude","city","neighborhood","justification"] as const).map(k=><label key={k} className="font-semibold">{k}<input value={locations[a.id]?.[k]??""} onChange={e=>setLocations(m=>({...m,[a.id]:{...m[a.id]!,[k]:e.target.value}}))} className="mt-1 w-full rounded-lg border bg-white p-2"/></label>)}</div>}
        </div>}
        <div className="mt-3 flex flex-wrap gap-2">
          {a.status==="pending"&&<button type="button" disabled={busy!==null} onClick={()=>void applicationDecision(a.id,"start_review")} className="rounded-lg border p-2 text-xs font-bold">Start verification</button>}
          {a.status==="reviewing"&&<button type="button" disabled={busy!==null||!a.emailVerified||!a.phoneVerified} onClick={()=>void applicationDecision(a.id,"approve")} className="rounded-lg bg-market-green p-2 text-xs font-bold text-white disabled:opacity-50">Approve merchant</button>}
          <button type="button" disabled={busy!==null} onClick={()=>void applicationDecision(a.id,"reject")} className="rounded-lg border border-red-200 p-2 text-xs font-bold text-red-700 disabled:opacity-50">Reject</button>
        </div>
      </article>)}{queues.applications.length===0&&<p className="text-sm text-market-muted">No merchant applications require review.</p>}</div>
    </section>}
    {can('admin.categories.manage') && <section id="catalogue-control" className="mt-6 rounded-2xl border border-market-line bg-white p-5">
      <h2 className="text-xl font-black">Category & subcategory availability</h2><p className="mt-1 text-xs text-market-muted">Operational catalogue toggles are applied on the backend and take effect in customer discovery and merchant listings.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">{queues.categories.map(c=><article key={c.key} className="rounded-xl border border-market-line p-4">
        <h3 className="font-bold">{c.name} · {c.active?"Enabled":"Disabled"}</h3>
        <label className="mt-2 block text-xs font-bold">Reason for category change<input value={categoryReasons[c.key]??""} onChange={e=>setCategoryReasons(m=>({...m,[c.key]:e.target.value}))} className="mt-1 w-full rounded-lg border p-2"/></label>
        <button type="button" disabled={busy!==null} onClick={()=>void categoryDecision(c.key,null,!c.active)} className="mt-2 rounded-lg border p-2 text-xs font-bold disabled:opacity-50">{c.active?"Disable":"Enable"} category</button>
        <details className="mt-3"><summary className="cursor-pointer text-xs font-bold">Subcategories ({c.subcategories.length})</summary><div className="mt-2 grid gap-2">{c.subcategories.map(sub=>{const key=`${c.key}:${sub.key}`;return <div key={sub.key} className="rounded-lg border p-2 text-xs"><p className="font-semibold">{sub.name} · {sub.active?"Enabled":"Disabled"}</p><input aria-label={`Reason for ${sub.name}`} value={categoryReasons[key]??""} onChange={e=>setCategoryReasons(m=>({...m,[key]:e.target.value}))} className="mt-2 w-full rounded border p-2"/><button type="button" disabled={busy!==null} onClick={()=>void categoryDecision(c.key,sub.key,!sub.active)} className="mt-2 rounded border px-2 py-1 font-bold disabled:opacity-50">{sub.active?"Disable":"Enable"}</button></div>})}</div></details>
      </article>)}</div>
    </section>}
    <div className="mt-6 grid gap-6 lg:grid-cols-2">{can('admin.products.moderate') && <section className="rounded-2xl border border-market-line bg-white p-5"><h2 className="text-xl font-black">Product moderation · {moderation.products.length}</h2><div className="mt-4 space-y-4">{moderation.products.map(p=><article key={p.id} className="rounded-xl border border-market-line p-4"><h3 className="font-bold">{p.name}</h3><p className="mt-1 text-xs text-market-muted">{p.merchantName} · GHS {p.price} · {p.status}</p>{input(`product:${p.id}`)}<div className="mt-3 flex flex-wrap gap-2">{(["approve","suspend","archive"] as const).map(action=><button key={action} type="button" disabled={busy!==null} className="rounded-xl border border-market-line px-3 py-2 text-xs font-bold disabled:opacity-50" onClick={()=>void take(`product:${p.id}`,reason=>moderateProduct({data:{productId:p.id,action,reason}}))}>{action}</button>)}</div></article>)}{!moderation.products.length&&<p className="text-sm text-market-muted">No products in the moderation snapshot.</p>}</div></section>}
    {can('admin.merchants.moderate') && <section className="rounded-2xl border border-market-line bg-white p-5"><h2 className="text-xl font-black">Merchant accounts · {moderation.merchants.length}</h2><div className="mt-4 space-y-4">{moderation.merchants.map(m=><article key={m.id} className="rounded-xl border border-market-line p-4"><h3 className="font-bold">{m.name}</h3><p className="mt-1 text-xs text-market-muted">{m.status} · {m.ownerEmail??"Owner email unavailable"}</p>{input(`merchant:${m.id}`)}<button type="button" disabled={busy!==null} className="mt-3 rounded-xl border border-market-line px-3 py-2 text-xs font-bold disabled:opacity-50" onClick={()=>void take(`merchant:${m.id}`,reason=>moderateMerchant({data:{merchantId:m.id,action:m.status==="suspended"?"reinstate":"suspend",reason}}))}>{m.status==="suspended"?"Reinstate":"Suspend"}</button></article>)}{!moderation.merchants.length&&<p className="text-sm text-market-muted">No merchant accounts found.</p>}</div></section>}
    {can('admin.customers.moderate') && <section className="rounded-2xl border border-market-line bg-white p-5 lg:col-span-2"><h2 className="text-xl font-black">Customer safeguards · {moderation.customers.length}</h2><div className="mt-4 grid gap-4 md:grid-cols-2">{moderation.customers.map(c=><article key={c.id} className="rounded-xl border border-market-line p-4"><h3 className="font-bold">{c.name}</h3><p className="mt-1 text-xs text-market-muted">{c.email} · {c.status}</p>{input(`customer:${c.id}`)}<button type="button" disabled={busy!==null} className="mt-3 rounded-xl border border-market-line px-3 py-2 text-xs font-bold disabled:opacity-50" onClick={()=>void take(`customer:${c.id}`,reason=>moderateCustomer({data:{userId:c.id,action:c.status==="blacklisted"?"unblacklist":"blacklist",reason}}))}>{c.status==="blacklisted"?"Remove blacklist":"Blacklist"}</button></article>)}{!moderation.customers.length&&<p className="text-sm text-market-muted">No customer accounts found.</p>}</div></section>}
    </div>
  </main>
}
