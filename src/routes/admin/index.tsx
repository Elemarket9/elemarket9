import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { getAdminAccessState } from "../../modules/administration/public/transport/admin/access.functions";
import { adminDefaultRoute } from "@/modules/administration/public/admin-default-route";
import { authClient, authEnabled, signOut } from "@/modules/identity/public/auth/client";
import { ExecutiveFaceLogin } from "@/components/executive-face-login";

export const Route = createFileRoute("/admin/")({
  loader: () => getAdminAccessState(),
  head: () => ({
    meta: [
      { name: "robots", content: "noindex,nofollow,noarchive" },
    ],
  }),
  component: AdminEntry,
});

function AdminEntry() {
  const access = Route.useLoaderData();
  const portalTitle = access.portal === "executive" ? "Executive Administration" : access.portal === "staff" ? "Employee Administration" : "ELEMARKET Operations";
  const [executiveMethod, setExecutiveMethod] = useState<"face" | "password">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInAdmin(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      sessionStorage.setItem("elemarket.admin.post2faCallback", "/admin");
      const result = await authClient.signIn.email({
        email: email.trim(),
        password,
      });
      if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) return;
      if (result.error) throw new Error("Invalid administrator credentials");

      const current = await getAdminAccessState();
      if (!current.authenticated || !current.isAdmin) {
        await signOut("");
        throw new Error("This account is not authorized for administrator access");
      }

      window.location.assign(current.twoFactorEnabled ? (adminDefaultRoute(current)) : "/admin/security");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Administrator sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  if (!authEnabled) {
    return (
      <main className="grid min-h-screen place-items-center bg-market-bg px-4 py-10">
        <section className="w-full max-w-md rounded-3xl border border-market-line bg-white p-7 shadow-market">
          <p className="text-xs font-black uppercase tracking-[.16em] text-market-muted">{portalTitle}</p>
          <h1 className="mt-3 text-2xl font-black">Administrator access unavailable</h1>
          <p className="mt-2 text-sm text-market-muted">Authentication is disabled in this environment. Administrator access fails closed.</p>
        </section>
      </main>
    );
  }

  if (access.authenticated && access.isAdmin) {
    return (
      <main className="grid min-h-screen place-items-center bg-market-bg px-4 py-10">
        <section className="w-full max-w-md rounded-3xl border border-market-line bg-white p-7 text-center shadow-market">
          <p className="text-xs font-black uppercase tracking-[.16em] text-market-muted">{portalTitle}</p>
          <h1 className="mt-3 text-2xl font-black">Administrator session active</h1>
          <p className="mt-2 text-sm text-market-muted">Signed in as {access.displayName ?? "administrator"}.</p>
          {access.twoFactorEnabled ? <button type="button" onClick={() => window.location.assign(adminDefaultRoute(access))} className="mt-6 h-12 w-full rounded-xl bg-black text-sm font-black text-white">Open admin dashboard</button> : <button type="button" onClick={() => window.location.assign("/admin/security")} className="mt-6 h-12 w-full rounded-xl bg-black text-sm font-black text-white">Secure administrator account</button>}
          {access.portal === "executive" && <a href="/admin/executive-face" className="mt-3 block text-sm font-bold text-market-green">Executive biometric enrollment</a>}
          <button type="button" onClick={() => void signOut("/admin")} className="mt-3 text-sm font-bold text-market-green">Sign out</button>
        </section>
      </main>
    );
  }

  if (access.authenticated && !access.isAdmin) {
    return (
      <main className="grid min-h-screen place-items-center bg-market-bg px-4 py-10">
        <section className="w-full max-w-md rounded-3xl border border-market-line bg-white p-7 shadow-market">
          <p className="text-xs font-black uppercase tracking-[.16em] text-market-muted">{portalTitle}</p>
          <h1 className="mt-3 text-2xl font-black">Administrator access required</h1>
          <p className="mt-2 text-sm text-market-muted">The signed-in account is not authorized to access the operations console.</p>
          <button type="button" onClick={() => void signOut("/admin")} className="mt-6 h-12 w-full rounded-xl bg-black text-sm font-black text-white">Sign out</button>
        </section>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-market-bg px-4 py-10">
      <section className="w-full max-w-md rounded-3xl border border-market-line bg-white p-7 shadow-market">
        <p className="text-xs font-black uppercase tracking-[.16em] text-market-muted">{portalTitle}</p>
        <h1 className="mt-3 text-2xl font-black">{access.portal === "executive" ? "Main Admin sign in" : "Employee administrator sign in"}</h1>
        {access.portal === "executive" && <p className="mt-2 text-sm text-market-muted">Choose either Face + Alphanumeric Passphrase or the existing Better Auth password + authenticator. Facial login is available only after security validation and activation.</p>}
        <p className="mt-2 text-sm text-market-muted">Only authorized accounts assigned to this administration portal may enter.</p>

        {access.portal === "executive" && <div className="mt-5 flex gap-2" role="group" aria-label="Executive sign in method">
          <button type="button" aria-pressed={executiveMethod === "face"} onClick={() => setExecutiveMethod("face")} className="flex-1 rounded-lg border px-3 py-2 text-sm font-semibold">Face + PIN</button>
          <button type="button" aria-pressed={executiveMethod === "password"} onClick={() => setExecutiveMethod("password")} className="flex-1 rounded-lg border px-3 py-2 text-sm font-semibold">Password + TOTP</button>
        </div>}
        {access.portal === "executive" && executiveMethod === "face" && <ExecutiveFaceLogin />}
        {(access.portal !== "executive" || executiveMethod === "password") && <form className="mt-7 space-y-4" onSubmit={signInAdmin}>
          <label className="block text-sm font-bold">
            Administrator email
            <input type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-market-line px-3 font-medium outline-none focus:border-market-green" />
          </label>
          <label className="block text-sm font-bold">
            Password
            <input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-market-line px-3 font-medium outline-none focus:border-market-green" />
          </label>
          {error ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p> : null}
          <button disabled={busy} className="h-12 w-full rounded-xl bg-black text-sm font-black text-white disabled:opacity-50">
            {busy ? "Authenticating…" : "Sign in to admin"}
          </button>
        </form>}
        {(access.portal !== "executive" || executiveMethod === "password") && <a href="/reset-password" className="mt-4 inline-block text-sm font-bold text-market-green">Forgot administrator password?</a>}
      </section>
    </main>
  );
}
