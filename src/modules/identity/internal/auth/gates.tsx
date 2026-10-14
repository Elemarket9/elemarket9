import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate } from "@tanstack/react-router";
import { authEnabled, signOut } from "./client";
import { useCurrentUser, useCurrentUserState } from "./use-current-user";
import { portalHref } from "@/lib/portal-links";
import { getMerchantLoginContext } from "./merchant-context.functions";
export const SIGN_IN_PATH = "/login";
export function SignedIn({ children }: { children: ReactNode }) { const { user } = useCurrentUserState(); return user ? <>{children}</> : null; }
export function SignedOut({ children }: { children: ReactNode }) { const { user, isPending } = useCurrentUserState(); if (isPending || user) return null; return <>{children}</>; }
export function RedirectToSignIn({ to = SIGN_IN_PATH }: { to?: string }) { return <Navigate to={to} />; }
export function SignInGate({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) { const { user, isPending } = useCurrentUserState(); if (isPending) return null; if (user) return <>{children}</>; return <>{fallback ?? <SignInButtons />}</>; }
export function SignInButtons() { return <Link to={SIGN_IN_PATH} className="inline-flex w-full max-w-sm items-center justify-center rounded-md border border-neutral-300 px-4 py-2 font-semibold hover:bg-neutral-100">Sign in or create an account</Link>; }
export function MerchantWorkspaceLink({ className = "text-sm font-bold text-market-green hover:underline" }: { className?: string }) {
  const { user, isPending } = useCurrentUserState();
  const [state, setState] = useState<"loading" | "merchant" | "apply" | "pending" | "hidden">("loading");

  useEffect(() => {
    let active = true;
    if (!authEnabled || isPending || !user || user.isDevFallback) {
      setState(authEnabled && isPending ? "loading" : "hidden");
      return () => { active = false; };
    }
    void getMerchantLoginContext()
      .then((context) => {
        if (!active) return;
        if (context.authorized) setState("merchant");
        else if (context.reason === "admin_only") setState("hidden");
        else if (["pending", "not_activated", "rejected", "suspended"].includes(context.reason)) setState("pending");
        else setState("apply");
      })
      .catch(() => { if (active) setState("hidden"); });
    return () => { active = false; };
  }, [isPending, user]);

  if (state === "loading" || state === "hidden") return null;
  if (state === "merchant") return <a href={portalHref("seller", "/merchant/dashboard")} className={className}>Merchant portal</a>;
  if (state === "pending") return <a href={portalHref("seller", "/merchant/status")} className={className}>Merchant application status</a>;
  return <a href={portalHref("seller", "/merchant/register")} className={className}>Become a merchant</a>;
}

export function UserButton() {
  const user = useCurrentUser(); const [signingOut,setSigningOut]=useState(false); if(!user) return null;
  const label=user.displayName ?? user.primaryEmail ?? "Account";
  return <div className="flex items-center gap-2">{user.profileImageUrl ? <Link to="/profile" aria-label="Open profile"><img src={user.profileImageUrl} alt="" className="h-8 w-8 rounded-full object-cover"/></Link> : <Link to="/profile" aria-label="Open profile" className="grid h-8 w-8 place-items-center rounded-full bg-black/10 text-sm font-medium dark:bg-white/20">{label.charAt(0).toUpperCase()}</Link>}<Link to="/profile" className="text-sm font-medium hover:underline">{label}</Link><MerchantWorkspaceLink />{authEnabled && !user.isDevFallback && <button type="button" disabled={signingOut} onClick={()=>{setSigningOut(true);void signOut().catch(()=>setSigningOut(false));}} className="cursor-pointer text-sm underline-offset-4 opacity-70 hover:underline disabled:cursor-wait">{signingOut ? "Signing out…" : "Sign out"}</button>}</div>;
}
