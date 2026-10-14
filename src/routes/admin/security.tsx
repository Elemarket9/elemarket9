import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "@/modules/identity/public/auth/client";
import { getAdminAccessState } from "../../modules/administration/public/transport/admin/access.functions";
import { adminDefaultRoute } from "@/modules/administration/public/admin-default-route";

export const Route = createFileRoute("/admin/security")({ loader: () => getAdminAccessState(), component: AdminSecurity });

function AdminSecurity() {
  const access = Route.useLoaderData();
  const [password,setPassword]=useState(""); const [uri,setUri]=useState<string|null>(null); const [codes,setCodes]=useState<string[]>([]); const [code,setCode]=useState(""); const [error,setError]=useState<string|null>(null); const [busy,setBusy]=useState(false);
  async function begin(){ setBusy(true); setError(null); const r=await authClient.twoFactor.enable({password,method:"totp",issuer:"ELEMARKET"}); if(r.error){setError(r.error.message??"Could not start 2FA setup");} else {
      const data = r.data;
      if (!data) {
        setError("2FA enrollment returned no setup data");
      } else if ("totpURI" in data) {
        setUri(data.totpURI ?? null);
        setCodes("backupCodes" in data ? data.backupCodes ?? [] : []);
      } else {
        setError("TOTP setup data was not returned by the authentication service");
      }
    } setBusy(false); }
  async function verify(){
    setBusy(true);
    setError(null);
    const r=await authClient.twoFactor.verifyTotp({code,trustDevice:false});
    if(r.error) {
      setError(r.error.message??"Invalid authenticator code");
    } else {
      // The current session was created before 2FA became mandatory. Do not
      // weaken the server-side session-assurance check; end this pre-2FA
      // session and require a fresh credential + TOTP sign-in instead.
      sessionStorage.setItem("elemarket.admin.post2faCallback", "/admin");
      const signOutResult = await authClient.signOut();
      if (signOutResult.error) {
        setError("2FA was enabled, but the previous administrator session could not be closed. Sign out and sign in again.");
      } else {
        window.location.assign("/admin");
        return;
      }
    }
    setBusy(false);
  }
  if(!access.authenticated||!access.isAdmin) return <main className="grid min-h-screen place-items-center bg-market-bg"><p>Administrator access required.</p></main>;
  if(access.twoFactorEnabled) return <main className="grid min-h-screen place-items-center bg-market-bg px-4"><section className="w-full max-w-lg rounded-3xl border border-market-line bg-white p-7 shadow-market"><h1 className="text-2xl font-black">Administrator 2FA is active</h1><p className="mt-2 text-sm text-market-muted">TOTP is required for administrator access. Return to the dashboard.</p>{access.portal === "executive" && <a className="mt-4 block text-sm font-bold text-market-green" href="/admin/executive-face">Enroll executive Face + Passphrase</a>}<button onClick={()=>window.location.assign(adminDefaultRoute(access))} className="mt-6 h-12 w-full rounded-xl bg-black font-black text-white">Open dashboard</button></section></main>;
  return <main className="grid min-h-screen place-items-center bg-market-bg px-4 py-10"><section className="w-full max-w-xl rounded-3xl border border-market-line bg-white p-7 shadow-market"><p className="text-xs font-black uppercase tracking-[.16em] text-market-muted">Mandatory administrator security</p><h1 className="mt-3 text-2xl font-black">Enable authenticator-based 2FA</h1><p className="mt-2 text-sm text-market-muted">Administrator actions are locked until TOTP is enrolled and verified. Store the backup codes offline.</p>{!uri?<><input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Current administrator password" className="mt-6 h-12 w-full rounded-xl border border-market-line px-3"/><button disabled={busy||password.length<12} onClick={()=>void begin()} className="mt-4 h-12 w-full rounded-xl bg-black font-black text-white disabled:opacity-50">{busy?"Preparing…":"Start 2FA enrollment"}</button></>:<><p className="mt-6 text-sm font-bold">Add this TOTP secret to your authenticator app:</p><textarea readOnly value={uri} className="mt-2 min-h-28 w-full rounded-xl border border-market-line p-3 text-xs"/><p className="mt-4 text-sm font-bold">Backup codes — store them offline:</p><pre className="mt-2 overflow-auto rounded-xl bg-neutral-950 p-4 text-xs text-white">{codes.join("\n")}</pre><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))} placeholder="Authenticator code" className="mt-4 h-12 w-full rounded-xl border border-market-line px-3 text-center text-xl font-black tracking-[.3em]"/><button disabled={busy||code.length!==6} onClick={()=>void verify()} className="mt-4 h-12 w-full rounded-xl bg-market-orange font-black text-white disabled:opacity-50">{busy?"Verifying…":"Verify and activate 2FA"}</button></>}{error&&<p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>}</section></main>;
}
