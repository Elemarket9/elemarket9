import { createFileRoute, Link } from "@tanstack/react-router";
export const Route=createFileRoute("/provider/")({component:ProviderGateway});
function ProviderGateway(){
 return <main className="min-h-screen bg-market-ink text-white">
  <section className="mx-auto max-w-6xl px-6 py-20">
   <p className="text-xs font-black uppercase tracking-[.22em] text-market-orange">ELEMARKET Provider Hub</p>
   <h1 className="mt-4 max-w-4xl text-5xl font-black tracking-tight">Operate financing and delivery services across ELEMARKET.</h1>
   <p className="mt-5 max-w-2xl text-lg leading-8 text-neutral-300">A dedicated gateway for external service providers. Manual processing is fully supported—an API integration is not required to start operating.</p>
   <div className="mt-8 flex flex-wrap gap-3"><Link to="/provider/login" className="rounded-xl bg-white px-5 py-3 font-black text-black">Provider sign in</Link><Link to="/provider/signup" className="rounded-xl border border-neutral-600 px-5 py-3 font-black">Apply as a provider</Link></div>
   <div className="mt-14 grid gap-4 md:grid-cols-3">
    {[["Manual financing","Receive applications, assign officers, request information, enter decisions and offers, and record servicing from the dashboard."],["Delivery operations","Accept jobs, update pickup/transit/delivery states, record exceptions and proof of delivery."],["API when ready","SMEs can start manually and move to hybrid/API operation later without changing tenant or dashboard."]].map(([h,p])=><article key={h} className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6"><h2 className="font-black">{h}</h2><p className="mt-2 text-sm leading-6 text-neutral-400">{p}</p></article>)}
   </div>
  </section>
 </main>
}