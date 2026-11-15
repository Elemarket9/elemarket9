import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CheckCircle2, Clock3, XCircle } from "lucide-react";
import { getGroupPaymentStatus } from "@/modules/payments/public/group-payment";

export const Route = createFileRoute("/payment/group-return")({ component: GroupPaymentReturn });

function GroupPaymentReturn() {
  const groupId=typeof window!=="undefined"
    ? new URLSearchParams(window.location.search).get("groupId") : null;
  const [status,setStatus]=useState("checking");
  const [amount,setAmount]=useState<string|null>(null);
  const [orders,setOrders]=useState<number|null>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{
    let active=true,timeout:ReturnType<typeof setTimeout>|null=null,attempts=0;
    async function check(){
      if(!groupId){setStatus("invalid");return;}
      try {
        const result=await getGroupPaymentStatus({data:{groupId}});
        if(!active)return;
        setStatus(result.status);setAmount(result.amount);setOrders(result.orders.length);setError(null);
        // Signed provider callbacks are authoritative. The browser return is not.
        if(result.status==="completed"||result.status==="failed")return;
      } catch {
        if(!active)return;
        setStatus("error");setError("Payment status is temporarily unavailable. Sign in and check your orders.");
      }
      if(++attempts<120 && active)timeout=setTimeout(()=>void check(),3000);
    }
    void check();
    return ()=>{active=false;if(timeout)clearTimeout(timeout);};
  },[groupId]);
  const confirmed=status==="completed",failed=status==="failed"||status==="invalid";
  const pending=!confirmed&&!failed;
  return <main className="min-h-screen bg-market-bg px-4 py-16">
    <section className="mx-auto max-w-xl rounded-3xl border border-market-line bg-white p-8 text-center shadow-market">
      {confirmed?<CheckCircle2 className="mx-auto text-market-green" size={50}/>:
        failed?<XCircle className="mx-auto text-red-600" size={50}/>:
        <Clock3 className="mx-auto text-market-orange" size={50}/>}
      <h1 className="mt-5 text-2xl font-black">
        {confirmed?"One payment confirmed for your merchant orders":
          failed?"Group payment was not completed":"Confirming your combined payment"}
      </h1>
      <p className="mt-3 text-sm text-market-muted">
        {error ?? (confirmed
          ? `Your GHS ${amount??""} payment was verified for ${orders??"all"} merchant orders.`
          : status==="needs_attention"
            ? "Provider confirmation requires reconciliation. Do not pay again; your payment remains under review."
            : "Waiting for one verified provider confirmation. Do not start another payment while this is pending.")}
      </p>
      <div className="mt-7 flex justify-center gap-3">
        <Link to="/orders" className="rounded-xl bg-market-green px-5 py-3 text-sm font-black text-white">View orders</Link>
        <Link to="/" className="rounded-xl border border-market-line px-5 py-3 text-sm font-black">Marketplace</Link>
      </div>
      {pending?<p className="mt-4 text-xs text-market-muted">Payment and seller settlement are confirmed only by ELEMARKET's server, never the redirect page.</p>:null}
    </section>
  </main>;
}
