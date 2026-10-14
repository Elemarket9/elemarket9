import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCurrentUserState } from "@/modules/identity/public/auth/use-current-user";
import { authClient, authEnabled } from "@/modules/identity/public/auth/client";
import { getProviderGatewayContext } from "../../modules/administration/public/transport/provider/gateway.functions";
export const Route=createFileRoute("/provider/login")({component:ProviderLogin});
function ProviderLogin(){
 const {user,isPending}=useCurrentUserState();
 useEffect(()=>{if(isPending||!user||user.isDevFallback)return;let active=true;
 void getProviderGatewayContext().then(result=>{if(!active)return;
 window.location.replace(result.authorized?"/provider/dashboard":result.application?"/provider/status":"/provider/signup");
 }).catch(()=>undefined);return()=>{active=false}},[isPending,user]);
 const [email,setEmail]=useState("");const [password,setPassword]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
 async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);setError(null);try{
  if(!authEnabled) throw new Error("Provider sign-in is unavailable in this environment");
  sessionStorage.setItem("elemarket.auth.post2faCallback", "/provider/login");
  const result=await authClient.signIn.email({email:email.trim(),password,callbackURL:"/provider/dashboard"});
  if(result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) return;
  if(result.error) throw new Error(result.error.message??"Invalid provider credentials");
  const ctx=await getProviderGatewayContext();
  if(!ctx.authorized){if(ctx.application){window.location.assign("/provider/status");return;}await authClient.signOut();throw new Error("This account is not an approved ELEMARKET provider. Apply through the Provider Hub.");}
  window.location.assign("/provider/dashboard");
 }catch(e){setError(e instanceof Error?e.message:"Provider sign-in failed")}finally{setBusy(false)}}
 return <main className="grid min-h-screen place-items-center bg-neutral-950 px-4 py-10 text-white"><section className="w-full max-w-md rounded-3xl border border-neutral-800 bg-neutral-900 p-8">
  <Link to="/provider" className="text-xs font-black uppercase tracking-[.2em] text-market-orange">ELEMARKET Provider Hub</Link><h1 className="mt-5 text-3xl font-black">Provider sign in</h1><p className="mt-2 text-sm text-neutral-400">For approved financing and delivery provider organizations only.</p>
  <form className="mt-7 space-y-4" onSubmit={submit}><label className="block text-sm font-bold">Business email<input type="email" required autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} className="mt-1 h-12 w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3"/></label><label className="block text-sm font-bold">Password<input type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} className="mt-1 h-12 w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3"/></label>{error?<p role="alert" className="rounded-xl bg-red-950 p-3 text-sm font-bold text-red-200">{error}</p>:null}<button disabled={busy} className="h-12 w-full rounded-xl bg-white font-black text-black disabled:opacity-50">{busy?"Authenticating…":"Sign in to Provider Hub"}</button></form>
  <div className="mt-6 border-t border-neutral-800 pt-5 text-center text-sm"><Link to="/provider/signup" className="font-bold text-market-orange">Apply as a provider</Link><Link to="/provider/staff-signup" className="mt-3 block text-neutral-400">Create provider staff account</Link><Link to="/reset-password" className="mt-3 block text-neutral-400">Forgot password?</Link></div>
 </section></main>
}