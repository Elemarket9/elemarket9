import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import {
  cancelFinanceApproval,
  decideFinanceApproval,
  loadFinanceApprovals,
  requestPayoutResolution,
} from "@/modules/administration/public/transport/admin/finance-approvals.functions";
import {
  enableMerchantWallet,
  listWalletReconciliation,
  resolveWalletReconciliationException,
} from "@/modules/wallet/public/transport/merchant/wallet.functions";
import { formatGhs as ghs, formatDateTime as when } from "@/modules/shared/public/display";

const APPROVER = ["admin.finance.refunds", "admin.finance.payouts"];
const WALLET_VIEW = ["admin.finance.view", "admin.finance.payouts"];

export const Route = createFileRoute("/admin/finance")({
  head: () => ({ meta: [{ title: "Finance approvals & payouts | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  loader: async () => {
    const access = await getAdminAccessState();
    const owner = access.staffRole === "owner";
    const has = (caps: string[]) => owner || caps.some((c) => access.capabilities.includes(c));
    if (!has([...APPROVER, ...WALLET_VIEW, "admin.finance.policy"])) throw redirect({ to: "/admin" });
    const [approvals, wallet] = await Promise.all([
      has(APPROVER) ? loadFinanceApprovals() : Promise.resolve(null),
      has(WALLET_VIEW) ? listWalletReconciliation() : Promise.resolve(null),
    ]);
    return {
      access, approvals, wallet,
      can: {
        payouts: has(["admin.finance.payouts"]),
        refunds: has(["admin.finance.refunds"]),
        policy: has(["admin.finance.policy"]),
      },
    };
  },
  component: Finance,
  errorComponent: () => (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl font-black">Finance access required</h1>
      <p className="mt-3 text-sm text-market-muted">Ask the Main Administrator for a finance permission.</p>
    </main>
  ),
});

const ACTION_LABEL: Record<string, string> = { order_refund: "Customer refund", wallet_payout_resolution: "Payout settlement" };
const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-900", approved: "bg-green-50 text-green-800", executed: "bg-green-50 text-green-800",
  rejected: "bg-market-soft text-market-muted", cancelled: "bg-market-soft text-market-muted", expired: "bg-market-soft text-market-muted",
  failed: "bg-red-50 text-red-800",
};

function Panel({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6 rounded-2xl border border-market-line bg-white p-5">
      <h2 className="text-xl font-black">{title}</h2>
      {intro ? <p className="mt-1 text-sm text-market-muted">{intro}</p> : null}
      {children}
    </section>
  );
}

function errorText(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  if (/fresh/i.test(m)) return "Please sign in again before approving money actions.";
  if (/forbidden|permission/i.test(m)) return "You don't have the permission this needs.";
  return m || "That did not work. Please try again.";
}

function Finance() {
  const { access, approvals, wallet, can } = Route.useLoaderData();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setMessage(null);
    try { setMessage({ kind: "ok", text: await fn() }); window.setTimeout(() => window.location.reload(), 1500); }
    catch (e) { setMessage({ kind: "error", text: errorText(e) }); setBusy(null); }
  };
  const pending = approvals?.approvals.filter((a) => a.status === "pending") ?? [];
  const history = approvals?.approvals.filter((a) => a.status !== "pending") ?? [];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
      <header className="rounded-3xl border border-market-line bg-white p-6">
        <p className="text-xs font-black uppercase tracking-widest text-market-muted">Finance controls</p>
        <h1 className="mt-2 text-3xl font-black">Finance approvals & payouts</h1>
        <p className="mt-2 text-sm text-market-muted">
          {approvals ? <>Refunds and payout settlements above <strong>{ghs(approvals.threshold)}</strong> need two different administrators: one submits, another approves. </> : null}
          Every decision is recorded in the audit history.
        </p>
      </header>
      {message ? (
        <p role={message.kind === "error" ? "alert" : "status"} className={`mt-5 rounded-xl p-4 text-sm ${message.kind === "error" ? "bg-red-50 text-red-800" : "bg-green-50 text-green-900"}`}>{message.text}</p>
      ) : null}

      {approvals ? (
        <Panel title={`Waiting for approval (${pending.length})`} intro="You can't approve a request you submitted yourself.">
          {pending.length ? (
            <ul className="mt-4 grid gap-3">
              {pending.map((a) => <PendingApproval key={a.id} a={a} mine={a.requestedBy === approvals.viewerId} busy={busy} run={run} />)}
            </ul>
          ) : <p className="mt-4 text-sm text-market-muted">Nothing is waiting.</p>}
          {history.length ? (
            <details className="mt-5">
              <summary className="cursor-pointer text-sm font-bold">Recent decisions ({history.length})</summary>
              <ul className="mt-3 grid gap-2 text-sm">
                {history.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-market-line px-3 py-2">
                    <span>{ACTION_LABEL[a.action] ?? a.action} · {a.subjectId.slice(-10)} · <strong>{ghs(a.amount)}</strong></span>
                    <span className="text-xs text-market-muted">
                      {a.requesterName ?? "—"} → {a.deciderName ?? "—"} · {when(a.decidedAt ?? a.createdAt)}
                      <span className={`ml-2 rounded-full px-2 py-0.5 font-bold ${STATUS_STYLE[a.status] ?? ""}`}>{a.status}</span>
                    </span>
                    {a.executionError ? <span className="w-full text-xs text-red-700">{a.executionError}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Panel>
      ) : null}

      {wallet ? (
        <>
          <Panel title={`Stuck merchant payouts (${wallet.quarantined.length})`}
            intro="Payouts the provider did not confirm. Check the provider's records first, then record what really happened.">
            {wallet.quarantined.length ? (
              <ul className="mt-4 grid gap-3">
                {wallet.quarantined.map((p) => <StuckPayout key={p.id} p={p} canAct={can.payouts} busy={busy} run={run} />)}
              </ul>
            ) : <p className="mt-4 text-sm text-market-muted">No stuck payouts.</p>}
          </Panel>
          <Panel title={`Reconciliation exceptions (${wallet.exceptions.length})`}
            intro="Differences found between ELEMARKET's records and the payout provider's. Resolving one records your explanation; it moves no money.">
            {wallet.exceptions.length ? (
              <ul className="mt-4 grid gap-3">
                {(wallet.exceptions as WalletException[]).map((x) => <ExceptionItem key={x.id} x={x} canAct={can.payouts} busy={busy} run={run} />)}
              </ul>
            ) : <p className="mt-4 text-sm text-market-muted">No open exceptions.</p>}
          </Panel>
        </>
      ) : null}

      {can.policy ? <MoveToWallet busy={busy} run={run} /> : null}
    </main>
  );
}

type Run = (key: string, fn: () => Promise<string>) => Promise<void>;
type Approval = NonNullable<ReturnType<typeof Route.useLoaderData>["approvals"]>["approvals"][number];

function PendingApproval({ a, mine, busy, run }: { a: Approval; mine: boolean; busy: string | null; run: Run }) {
  const [note, setNote] = useState("");
  const what = a.action === "order_refund"
    ? `Refund order ${a.subjectId}`
    : `Mark payout ${a.subjectId} as ${a.payoutOutcome === "paid" ? "PAID" : "FAILED (money returns to merchant)"}`;
  return (
    <li className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-black">{ACTION_LABEL[a.action] ?? a.action} · {ghs(a.amount)}</p>
        <p className="text-xs text-market-muted">Expires {when(a.expiresAt)}</p>
      </div>
      <p className="mt-1 text-sm">{what}</p>
      <p className="mt-1 text-sm text-market-muted">Submitted by <strong>{a.requesterName ?? a.requestedBy}</strong> on {when(a.createdAt)}: “{a.reason}”</p>
      {a.providerReference ? <p className="mt-1 text-xs text-market-muted">Provider reference: {a.providerReference}</p> : null}
      {mine ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="font-semibold">Waiting for another administrator.</span>
          <button type="button" disabled={busy !== null} className="rounded-xl border border-market-line bg-white px-4 py-2 font-bold disabled:opacity-50"
            onClick={() => void run(a.id, async () => { await cancelFinanceApproval({ data: { approvalId: a.id } }); return "Request withdrawn."; })}>Withdraw request</button>
        </div>
      ) : (
        <div className="mt-3 grid gap-2">
          <label className="text-sm font-bold">Your reason (required)
            <input value={note} onChange={(e) => setNote(e.target.value)} minLength={12} maxLength={2000} className="mt-1 w-full rounded-xl border border-market-line bg-white p-2" placeholder="e.g. Checked provider dashboard; refund matches order" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy !== null || note.trim().length < 12} className="rounded-xl bg-market-green px-4 py-2 text-sm font-black text-white disabled:opacity-50"
              onClick={() => void run(a.id, async () => { await decideFinanceApproval({ data: { approvalId: a.id, decision: "approve", note } }); return "Approved and carried out."; })}>Approve</button>
            <button type="button" disabled={busy !== null || note.trim().length < 12} className="rounded-xl border border-market-line bg-white px-4 py-2 text-sm font-black disabled:opacity-50"
              onClick={() => void run(a.id, async () => { await decideFinanceApproval({ data: { approvalId: a.id, decision: "reject", note } }); return "Rejected. Nothing was changed."; })}>Reject</button>
          </div>
        </div>
      )}
    </li>
  );
}

type Wallet = NonNullable<ReturnType<typeof Route.useLoaderData>["wallet"]>;
type WalletException = { id: string; kind: string; severity: string; payout_id: string | null; merchant_id: string | null; created_at: string };

function StuckPayout({ p, canAct, busy, run }: { p: Wallet["quarantined"][number]; canAct: boolean; busy: string | null; run: Run }) {
  const [outcome, setOutcome] = useState<"paid" | "failed" | "requeue">("requeue");
  const [evidence, setEvidence] = useState("");
  const [providerReference, setProviderReference] = useState("");
  return (
    <li className="rounded-xl border border-market-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-black">{ghs(p.amount)} <span className="text-sm font-normal text-market-muted">(merchant receives {ghs(p.net_amount)})</span></p>
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-900">{p.status.replace("_", " ")}</span>
      </div>
      <p className="mt-1 text-xs text-market-muted">Payout {p.id} · merchant {p.merchant_id} · {p.driver_key}{p.provider_reference ? ` · ref ${p.provider_reference}` : ""} · updated {when(p.updated_at)}</p>
      {p.failure_reason ? <p className="mt-1 text-sm">{p.failure_reason}</p> : null}
      {canAct ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-sm font-bold">What the provider shows
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} className="mt-1 w-full rounded-xl border border-market-line p-2">
              <option value="requeue">Not sent yet: try sending again</option>
              <option value="paid">Paid: money reached the merchant</option>
              <option value="failed">Failed: nothing was sent (returns funds to merchant)</option>
            </select>
          </label>
          <label className="text-sm font-bold">Provider reference (optional)
            <input value={providerReference} onChange={(e) => setProviderReference(e.target.value)} maxLength={256} className="mt-1 w-full rounded-xl border border-market-line p-2" />
          </label>
          <label className="text-sm font-bold sm:col-span-2">Evidence (what you checked, 20+ characters)
            <input value={evidence} onChange={(e) => setEvidence(e.target.value)} minLength={20} maxLength={2000} className="mt-1 w-full rounded-xl border border-market-line p-2" />
          </label>
          <button type="button" disabled={busy !== null || evidence.trim().length < 20}
            className="rounded-xl bg-market-green px-4 py-2 text-sm font-black text-white disabled:opacity-50 sm:col-span-2"
            onClick={() => void run(p.id, async () => {
              const r = await requestPayoutResolution({ data: { payoutId: p.id, outcome, evidence, providerReference: providerReference.trim() || undefined } });
              return r.status === "awaiting_approval" ? "Recorded. A second administrator must approve it before it takes effect." : "Payout updated.";
            })}>Record outcome</button>
        </div>
      ) : <p className="mt-2 text-xs text-market-muted">Settling payouts needs the payout settlement permission.</p>}
    </li>
  );
}

function ExceptionItem({ x, canAct, busy, run }: { x: WalletException; canAct: boolean; busy: string | null; run: Run }) {
  const [resolution, setResolution] = useState("");
  return (
    <li className="rounded-xl border border-market-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-black">{x.kind.replaceAll("_", " ")}</p>
        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${x.severity === "critical" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`}>{x.severity}</span>
      </div>
      <p className="mt-1 text-xs text-market-muted">#{x.id}{x.payout_id ? ` · payout ${x.payout_id}` : ""}{x.merchant_id ? ` · merchant ${x.merchant_id}` : ""} · {when(x.created_at)}</p>
      {canAct ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={resolution} onChange={(e) => setResolution(e.target.value)} minLength={20} maxLength={2000} placeholder="How this was resolved (20+ characters)" className="min-w-0 flex-1 rounded-xl border border-market-line p-2 text-sm" />
          <button type="button" disabled={busy !== null || resolution.trim().length < 20} className="rounded-xl border border-market-line px-4 py-2 text-sm font-black disabled:opacity-50"
            onClick={() => void run(`x${x.id}`, async () => { await resolveWalletReconciliationException({ data: { exceptionId: x.id, resolution } }); return "Exception resolved."; })}>Resolve</button>
        </div>
      ) : null}
    </li>
  );
}

function MoveToWallet({ busy, run }: { busy: string | null; run: Run }) {
  const [merchantId, setMerchantId] = useState("");
  return (
    <Panel title="Move a merchant to wallet payouts"
      intro="New merchants already start on the wallet. Use this for merchants still paid by Paystack split. Their future sales go to the ELEMARKET wallet: held until delivery and the return window for ordinary merchants, available as soon as the customer pays for enterprise merchants. Refused while the merchant has unpaid checkouts.">
      <div className="mt-4 flex flex-wrap gap-2">
        <input value={merchantId} onChange={(e) => setMerchantId(e.target.value)} maxLength={128} placeholder="Merchant ID" aria-label="Merchant ID" className="min-w-0 flex-1 rounded-xl border border-market-line p-2 text-sm" />
        <button type="button" disabled={busy !== null || !merchantId.trim()} className="rounded-xl bg-market-green px-4 py-2 text-sm font-black text-white disabled:opacity-50"
          onClick={() => void run("move", async () => { await enableMerchantWallet({ data: { merchantId: merchantId.trim() } }); return "Merchant moved to wallet payouts."; })}>Move to wallet</button>
      </div>
    </Panel>
  );
}
