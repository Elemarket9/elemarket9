import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "@/modules/identity/public/auth/client";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({ token: typeof search.token === "string" && search.token.length <= 512 ? search.token : undefined }),
  component: ResetPassword,
});

function ResetPassword() {
  const { token } = Route.useSearch();
  return <ResetPasswordForm key={token ?? "request"} token={token ?? null} />;
}

function ResetPasswordForm({ token }: { token: string | null }) {
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestReset(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const { error: err } = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: "/reset-password" });
      if (err) throw new Error(err.message ?? "Could not request password reset");
      setSent(true);
    } catch { setError("We could not start the password reset. Please try again."); }
    finally { setBusy(false); }
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    if (newPassword.length < 12) { setError("Password must be at least 12 characters"); return; }
    setBusy(true); setError(null);
    try {
      const { error: err } = await authClient.resetPassword({ newPassword, token });
      if (err) throw new Error(err.message ?? "Could not reset password");
      setDone(true);
    } catch { setError("We could not reset the password. Please try again."); }
    finally { setBusy(false); }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-market-bg px-4 py-10">
      <div className="w-full max-w-md rounded-3xl border border-market-line bg-white p-7 shadow-market">
        <Link to="/" className="text-2xl font-black tracking-[-0.04em] text-market-green">ELE<span className="text-market-orange">MARKET</span></Link>
        <h1 className="mt-5 text-2xl font-black">Reset your password</h1>
        {done ? (
          <div className="mt-6 space-y-4"><p className="rounded-xl bg-market-soft p-4 text-sm font-semibold">Your password has been reset. You can sign in with your new password.</p><Link to="/login" className="inline-flex font-bold text-market-green">Return to sign in</Link></div>
        ) : token ? (
          <form className="mt-6 space-y-3" onSubmit={resetPassword}>
            <label className="block text-sm font-bold">New password<input type="password" required minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-market-line px-3" autoComplete="new-password" /></label>
            {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>}
            <button disabled={busy} className="h-12 w-full rounded-xl bg-market-orange text-sm font-black text-white disabled:opacity-50">{busy ? "Please wait…" : "Set new password"}</button>
          </form>
        ) : (
          <form className="mt-6 space-y-3" onSubmit={requestReset}>
            <p className="text-sm text-market-muted">Enter your account email and we'll send a password reset link.</p>
            <label className="block text-sm font-bold">Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-market-line px-3" autoComplete="email" /></label>
            {sent && <p className="rounded-xl bg-market-soft p-3 text-sm font-semibold">If an account exists for that email, a reset message will be sent.</p>}
            {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>}
            <button disabled={busy} className="h-12 w-full rounded-xl bg-market-orange text-sm font-black text-white disabled:opacity-50">{busy ? "Please wait…" : "Send reset link"}</button>
          </form>
        )}
      </div>
    </main>
  );
}
