import { portalHref } from "@/lib/portal-links";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { authClient, authEnabled } from "@/modules/identity/public/auth/client";
import { SignedIn, UserButton } from "@/modules/identity/public/auth/gates";
import { saveSignupProfile } from "@/modules/identity/public/auth/account.functions";
import { requestEmailOtpCode, verifyEmailOtpCode } from "@/modules/identity/public/auth/otp";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailChallengeId, setEmailChallengeId] = useState<string | null>(null);
  const [emailCode, setEmailCode] = useState("");
  const [verificationMode, setVerificationMode] = useState<"signup" | "login" | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        if (!phone.trim()) throw new Error("Phone number is required");
        const { error: err } = await authClient.signUp.email({
          email: email.trim(),
          password,
          name: name.trim() || email.split("@")[0] || "Shopper",
          callbackURL: "/",
        });
        if (err) throw new Error(err.message ?? "Could not create account");
        const otp = await requestEmailOtpCode({ data: { email: email.trim(), purpose: "signup" } });
        setEmailChallengeId(otp.challengeId);
        setEmailCode("");
        setVerificationMode("signup");
        return;
      } else {
        sessionStorage.setItem("elemarket.auth.post2faCallback", "/");
        const result = await authClient.signIn.email({
          email: email.trim(),
          password,
        });
        const err = result.error;
        if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) return;
        if (err) {
          const authError = err as typeof err & { status?: number; code?: string };
          const notVerified = authError.status === 403 || authError.code === "EMAIL_NOT_VERIFIED";
          if (notVerified) {
            const otp = await requestEmailOtpCode({ data: { email: email.trim(), purpose: "login" } });
            setEmailChallengeId(otp.challengeId);
            setEmailCode("");
            setVerificationMode("login");
            return;
          }
          throw new Error(err.message ?? "Could not sign in");
        }
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  async function verifyEmail() {
    if (!emailChallengeId || !verificationMode) return;
    setError(null);
    setBusy(true);
    try {
      await verifyEmailOtpCode({ data: { challengeId: emailChallengeId, code: emailCode, purpose: verificationMode } });
      const signInResult = await authClient.signIn.email({
        email: email.trim(),
        password,
      });
      if (signInResult.data && "twoFactorRedirect" in signInResult.data && signInResult.data.twoFactorRedirect) return;
      if (signInResult.error) throw new Error(signInResult.error.message ?? "Email verified, but sign-in failed");
      if (verificationMode === "signup") {
        await saveSignupProfile({ data: { name: name.trim() || email.split("@")[0] || "Shopper", phone: phone.trim() } });
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Email verification failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-market-bg px-4 py-10">
      <div className="w-full max-w-md rounded-3xl border border-market-line bg-white p-7 shadow-market">
        <Link to="/" className="text-2xl font-black tracking-[-0.04em] text-market-green">
          ELE<span className="text-market-orange">MARKET</span>
        </Link>
        <h1 className="mt-5 text-2xl font-black">{mode === "signup" ? "Create your ELEMARKET account" : "Welcome back"}</h1>
        <p className="mt-2 text-sm leading-6 text-market-muted">{mode === "signup" ? "Browse freely, then create one account to checkout, track orders, save searches and contact support." : "Sign in to checkout, track orders, manage returns and continue shopping."}</p>

        <SignedIn>
          <div className="mt-6 rounded-2xl bg-market-soft p-4">
            <p className="text-sm font-semibold">You are already signed in.</p>
            <div className="mt-3"><UserButton /></div>
            <Link to="/" className="mt-4 inline-flex text-sm font-bold text-market-green">Continue shopping</Link>
          </div>
        </SignedIn>

        {authEnabled ? (
          <>
            <div className="my-6 flex items-center gap-3 text-xs font-bold uppercase tracking-[.14em] text-market-muted">
              <span className="h-px flex-1 bg-market-line" /> or email <span className="h-px flex-1 bg-market-line" />
            </div>
            {emailChallengeId && verificationMode ? (
              <div className="rounded-2xl border border-market-line bg-market-soft p-4">
                <p className="text-sm font-bold">Verify your email</p>
                <p className="mt-1 text-sm text-market-muted">Enter the 6-digit code sent to {email.trim()}.</p>
                <input
                  value={emailCode}
                  onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  className="mt-3 h-12 w-full rounded-xl border border-market-line px-3 text-center text-xl font-black tracking-[0.35em]"
                  placeholder="000000"
                />
                {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>}
                <button type="button" disabled={busy || emailCode.length !== 6} onClick={verifyEmail} className="mt-3 h-12 w-full rounded-xl bg-market-orange text-sm font-black text-white disabled:opacity-50">
                  {busy ? "Verifying…" : "Verify email"}
                </button>
                <button type="button" disabled={busy} onClick={async () => {
                  setError(null);
                  try {
                    const otp = await requestEmailOtpCode({ data: { email: email.trim(), purpose: verificationMode ?? "signup" } });
                    setEmailChallengeId(otp.challengeId);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Could not resend code");
                  }
                }} className="mt-3 block w-full text-sm font-bold text-market-green disabled:opacity-50">
                  Resend code
                </button>
              </div>
            ) : (
            <form className="space-y-3" onSubmit={submit}>
              {mode === "signup" && (
                <label className="block text-sm font-bold">
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-market-line px-3 font-medium outline-none focus:border-market-green" autoComplete="name" />
                </label>
              )}
              {mode === "signup" && (
                <label className="block text-sm font-bold">
                  Phone number
                  <input type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="05XXXXXXXX or +2335XXXXXXXX" className="mt-1 h-11 w-full rounded-xl border border-market-line px-3 font-medium outline-none focus:border-market-green" autoComplete="tel" inputMode="tel" />
                </label>
              )}
              <label className="block text-sm font-bold">
                Email
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-market-line px-3 font-medium outline-none focus:border-market-green" autoComplete="email" />
              </label>
              <label className="block text-sm font-bold">
                Password
                <input type="password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-market-line px-3 font-medium outline-none focus:border-market-green" autoComplete={mode === "signup" ? "new-password" : "current-password"} />
              </label>
              {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>}
              <button disabled={busy} className="h-12 w-full rounded-xl bg-market-orange text-sm font-black text-white disabled:opacity-50">
                {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
              </button>
            </form>
            )}
            {mode === "signin" && <Link to="/reset-password" className="mt-4 inline-block text-sm font-bold text-market-green">Forgot password?</Link>}
            <button type="button" className="mt-4 block text-sm font-bold text-market-green" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setEmailChallengeId(null); setEmailCode(""); setVerificationMode(null); setError(null); }}>
              {mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}
            </button>
            <a href={portalHref("seller", "/merchant/login")} className="mt-3 block text-sm font-bold text-market-green">Merchant? Sign in to merchant portal</a>
          </>
        ) : (
          <p className="mt-6 text-sm text-market-muted">Sign-in is disabled.</p>
        )}
      </div>
    </main>
  );
}
