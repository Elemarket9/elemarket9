import {createFileRoute,Link} from "@tanstack/react-router";
import {useState} from "react";
import {listMyDeliveryCompanies,selectDeliveryCompany} from "@/modules/logistics/public/transport/company-context.functions";
export const Route=createFileRoute('/provider/company')({loader:()=>listMyDeliveryCompanies(),component:Company});
function Company(){
 const data=Route.useLoaderData();const [message,setMessage]=useState('');
 return <main className="mx-auto max-w-2xl space-y-5 p-8"><h1 className="text-3xl font-bold">Choose company</h1><p>Company operations use your selected active membership. Rider assignments remain bound to each job.</p>
 {message?<p role="status">{message}</p>:null}{data.companies.map(c=><button key={c.id} className="block w-full rounded-xl border p-4 text-left" onClick={async()=>{try{await selectDeliveryCompany({data:{organizationId:c.id}});location.href='/provider/dashboard'}catch(e){setMessage(e instanceof Error?e.message:'Unable to select company')}}}>{c.name} · {c.role}{data.selected===c.id?' · selected':''}</button>)}
 {!data.companies.length?<p>No active delivery company membership.</p>:null}<Link to="/provider/rider">My assigned deliveries</Link></main>;
}
