import { portalHref } from "@/lib/portal-links";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCurrentUserState } from "@/modules/identity/public/auth/use-current-user";
import { getMerchantLoginContext, type MerchantLoginContext } from "@/modules/identity/public/auth/merchant-context.functions";
import { getMerchantRegistrationContext, markPhoneVerified } from "@/modules/identity/public/auth/account.functions";
import { requestOtpCode } from "@/modules/identity/public/auth/otp";

export const Route = createFileRoute("/merchant/status")({ component: MerchantStatus });

type Registration = Awaited<ReturnType<typeof getMerchantRegistrationContext>>;
const labels: Record<NonNullable<Extract<MerchantLoginContext,{authorized:false}>["reason"]>,string> = {
  not_found: "You have not submitted a merchant application yet.",
  pending: "Your merchant application has been received and is awaiting review.",
  rejected: "Your application was not approved. Please contact support for details before applying again.",
  not_activated: "Your application is approved. Merchant workspace activation is pending.",
  suspended: "Merchant access is suspended or revoked. Contact support for assistance.",
  admin_only: "Administrator accounts cannot apply through the merchant portal.",
};

function MerchantStatus() {
  const {user,isPending}=useCurrentUserState();
  const [status,setStatus]=useState<MerchantLoginContext|null>(null);
  const [registration,setRegistration]=useState<Registration|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [challenge,setChallenge]=useState<string|null>(null);
  const [code,setCode]=useState("");
  const [error,setError]=useState<string|null>(null);
  const [message,setMessage]=useState<string|null>(null);

  useEffect(()=>{
    if(isPending)return;
    if(!user){setLoading(false);return;}
    let active=true;
    void Promise.all([getMerchantLoginContext(),getMerchantRegistrationContext().catch(()=>null)])
      .then(([result,context])=>{if(active){setStatus(result);setRegistration(context);setLoading(false);}})
      .catch(()=>{if(active){setError("Merchant application status could not be loaded. Please try again.");setLoading(false);}});
    return ()=>{active=false;};
  },[user,isPending]);

  async function sendCode(){
    if(!registration?.signedIn || !registration.phone)return;
    setBusy(true);setError(null);setMessage(null);
    try{
      const result=await requestOtpCode({data:{number:registration.phone,purpose:"phone_verification"}});
      setChallenge(result.challengeId);
      setMessage("A verification code was sent to your registered number.");
    }catch(e){setError(e instanceof Error?e.message:"Could not send the verification code");}
    finally{setBusy(false);}
  }
  async function verifyCode(){
    if(!challenge || code.length!==6)return;
    setBusy(true);setError(null);setMessage(null);
    try{
      await markPhoneVerified({data:{challengeId:challenge,code}});
      setRegistration(v=>v?.signedIn?{...v,phoneVerified:true}:v);
      setChallenge(null);setCode("");
      setMessage("Phone verification completed. Your application can continue through review.");
    }catch(e){setError(e instanceof Error?e.message:"Phone verification failed");}
    finally{setBusy(false);}
  }

  return <main className="min-h-screen bg-market-bg px-4 py-12"><section className="mx-auto max-w-xl rounded-3xl border border-market-line bg-white p-7 shadow-market">
    <a href={portalHref("marketplace")} className="text-sm font-black text-market-green">ELEMARKET</a>
    <h1 className="mt-5 text-3xl font-black">Merchant application status</h1>
    {isPending||loading?<p className="mt-5 text-sm text-market-muted">Checking your application…</p>:
      !user?<div className="mt-5"><p className="text-sm text-market-muted">Sign in with your existing account to view your merchant application.</p><Link to="/login" className="mt-4 inline-flex rounded-xl bg-market-green px-5 py-3 font-bold text-white">Sign in</Link></div>:
      status?.authorized?<div className="mt-5"><p className="text-sm text-market-muted">Your merchant workspace is active.</p><Link to="/merchant/dashboard" className="mt-4 inline-flex rounded-xl bg-market-green px-5 py-3 font-bold text-white">Open merchant dashboard</Link></div>:
      <div className="mt-5"><p className="rounded-xl bg-market-soft p-4 text-sm font-semibold text-market-green">{status ? labels[status.reason] : "Status unavailable"}</p>
        {status?.reason==="not_found" || status?.reason==="rejected"?<Link to="/merchant/register" className="mt-4 inline-flex rounded-xl border border-market-line px-4 py-2.5 font-bold text-market-green">{status.reason==="rejected"?"Start a new application":"Apply as a merchant"}</Link>:null}
        {status?.reason==="pending" && registration?.signedIn && registration.phone && !registration.phoneVerified ? <div className="mt-6 rounded-xl border border-market-line p-4">
          <h2 className="font-black">Complete phone verification</h2>
          <p className="mt-1 text-xs text-market-muted">If the registration page was refreshed, you can resume verification here without submitting a duplicate business application.</p>
          <p className="mt-3 text-sm">Registered number: <b>{registration.phone}</b></p>
          <button type="button" disabled={busy} onClick={()=>void sendCode()} className="mt-3 rounded-xl bg-market-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{challenge?"Resend code":"Send phone verification code"}</button>
          {challenge?<div className="mt-3 flex flex-wrap items-center gap-2"><input aria-label="Six-digit verification code" inputMode="numeric" value={code} maxLength={6} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))} className="h-11 w-40 rounded-xl border border-market-line px-3"/><button type="button" disabled={busy||code.length!==6} onClick={()=>void verifyCode()} className="h-11 rounded-xl bg-market-orange px-4 text-sm font-black text-white disabled:opacity-50">Verify code</button></div>:null}
        </div>:null}
      </div>}
    {error?<p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>:null}
    {message?<p role="status" className="mt-4 rounded-xl bg-green-50 p-3 text-sm text-green-700">{message}</p>:null}
    <div className="mt-6 flex gap-3 border-t border-market-line pt-5"><Link to="/support" className="text-sm font-bold text-market-green">Contact support</Link><a href={portalHref("marketplace")} className="text-sm font-bold text-market-muted">Back to marketplace</a></div>
  </section></main>;
}
