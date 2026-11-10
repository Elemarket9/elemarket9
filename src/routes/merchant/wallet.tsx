import { createFileRoute } from "@tanstack/react-router";
import { useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import {
  addMerchantPayoutDestination,
  cancelMerchantWithdrawal,
  listWalletMerchants,
  loadMerchantWallet,
  previewMerchantWithdrawal,
  requestMerchantWithdrawal,
} from "../../modules/wallet/public/transport/merchant/wallet.functions";

type Snapshot = Awaited<ReturnType<typeof loadMerchantWallet>>;

export const Route = createFileRoute("/merchant/wallet")({
  validateSearch: z.object({ merchant: z.string().max(128).optional() }),
  loaderDeps: ({ search }) => ({ merchant: search.merchant }),
  loader: async ({ deps }) => {
    const merchants = await listWalletMerchants();
    const merchantId = merchants.find((m) => m.id === deps.merchant)?.id ?? merchants[0]?.id;
    if (!merchantId) return { merchants, wallet: null };
    return { merchants, wallet: await loadMerchantWallet({ data: { merchantId } }) };
  },
  head: () => ({ meta: [{ title: "Wallet · ELEMARKET Seller" }] }),
  component: WalletPage,
  errorComponent: () => (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl font-black">Merchant access required</h1>
      <p className="mt-3 text-sm text-market-muted">Sign in with your merchant account to see your wallet.</p>
    </main>
  ),
});

const BUCKET_LABEL: Record<string, string> = {
  withheld: "Withheld", available: "Available", processing: "Reserved / being paid", paid_out: "Paid out", fees: "Transfer fees",
  recovery: "Owed from refunds",
};
const TYPE_LABEL: Record<string, string> = {
  sale: "Sale", release: "Released", refund: "Refund", payout_requested: "Withdrawal requested",
  payout_paid: "Withdrawal paid", payout_fee: "Transfer fee", payout_returned: "Withdrawal returned",
  payout_cancelled: "Withdrawal cancelled", late_payout_paid: "Withdrawal confirmed late by provider", reclassification: "Balance correction",
};
const STATUS_LABEL: Record<string, string> = {
  reserved: "Reserved", processing: "Processing", under_review: "Under review by ELEMARKET", completed: "Completed",
  failed: "Failed (returned to available)", cancelled: "Cancelled",
};

const ghs = (v: string) => `GH₵ ${Number(v).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (v: string | null) => (v ? new Date(v).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" }) : "—");

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const known: Array<[RegExp, string]> = [
    [/fresh authentication/i, "Please sign in again before moving money."],
    [/exceeds available/i, "That is more than your available balance."],
    [/already in progress/i, "A withdrawal is already in progress. Wait for it to finish."],
    [/transfer fee/i, "The amount must be larger than the transfer fee."],
    [/not verified/i, "Choose a verified payout account."],
    [/payouts are not configured/i, "Withdrawals are not switched on yet. Contact ELEMARKET support."],
    [/previous payout provider/i, "This payout account was set up with a previous provider. Add it again."],
    [/only the merchant/i, "Only the merchant owner can move wallet funds."],
    [/cooling period/i, "New payout accounts can be used 24 hours after they are added, for your security."],
    [/below the minimum/i, "That is below the minimum withdrawal."],
    [/above the maximum/i, "That is above the maximum single withdrawal."],
    [/daily withdrawal/i, "You have reached today's withdrawal limit."],
    [/can no longer be cancelled/i, "This withdrawal has already been sent and can't be cancelled."],
    [/too many|rate/i, "Too many attempts. Try again in a few minutes."],
  ];
  return known.find(([re]) => re.test(message))?.[1] ?? "That did not work. Please try again.";
}

function Card({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-market-line bg-white p-5 shadow-market ${className}`}>
      <h2 className="text-lg font-black">{title}</h2>
      {children}
    </section>
  );
}
function Button({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`rounded-xl px-4 py-2 text-sm font-black disabled:opacity-50 ${props.className ?? "bg-market-green text-white"}`}>{children}</button>;
}

function WalletPage() {
  const { merchants, wallet } = Route.useLoaderData();
  if (!wallet) return <main className="mx-auto max-w-xl px-4 py-16 text-center"><h1 className="text-3xl font-black">No active merchant workspace</h1></main>;
  const merchantName = merchants.find((m) => m.id === wallet.merchantId)?.name ?? "Your shop";
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <a href={`/merchant/dashboard`} className="text-xs font-bold text-market-green hover:underline">← Seller workspace</a>
          <h1 className="mt-2 text-3xl font-black">Wallet</h1>
          <p className="mt-1 text-sm text-market-muted">{merchantName}</p>
        </div>
        {merchants.length > 1 ? (
          <label className="text-sm font-bold">Shop{" "}
            <select className="market-input ml-2 rounded-xl border border-market-line px-3 py-2" value={wallet.merchantId}
              onChange={(e) => { window.location.href = `/merchant/wallet?merchant=${encodeURIComponent(e.target.value)}`; }}>
              {merchants.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        ) : null}
      </header>
      {!wallet.walletEnabled ? (
        <p className="mt-4 rounded-xl border border-market-line bg-market-soft p-3 text-sm">
          Your sales are currently paid to you directly by the payment provider at checkout. Ask ELEMARKET to move your shop to the wallet to hold and withdraw earnings here.
        </p>
      ) : null}
      <Balances wallet={wallet} />
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Withdraw wallet={wallet} />
        <Destinations wallet={wallet} />
        <Withheld wallet={wallet} />
        <Payouts wallet={wallet} />
        <Ledger wallet={wallet} />
      </div>
    </main>
  );
}

function Balances({ wallet }: { wallet: Snapshot }) {
  const b = wallet.balances;
  const tiles: Array<[string, string, string]> = [
    ["Available to withdraw", b.available, "Released earnings you can withdraw now."],
    ["Pending", b.pending, "Paid orders waiting for delivery confirmation."],
    ["On hold", b.onHold, "Delivered; held until the return window closes and nothing is disputed."],
    ["Withdrawals in progress", (Number(b.reserved) + Number(b.processing)).toFixed(2), "Reserved or being sent to your account."],
    ["Paid out", b.paidOut, "Sent to your account, after transfer fees."],
  ];
  return (
    <section className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Wallet balances">
      {tiles.map(([label, value, hint], i) => (
        <div key={label} className={`rounded-2xl border border-market-line p-4 shadow-market ${i === 0 ? "bg-market-mint" : "bg-white"}`}>
          <p className="text-xs font-black uppercase tracking-wide text-market-muted">{label}</p>
          <p className="mt-2 text-2xl font-black">{ghs(value)}</p>
          <p className="mt-1 text-xs text-market-muted">{hint}</p>
        </div>
      ))}
      <p className="text-xs text-market-muted sm:col-span-2 lg:col-span-5">
        Total earnings {ghs(b.totalSales)} · Refunded {ghs(b.refunded)} · Failed withdrawals {ghs(b.failedWithdrawals)} · Transfer fees paid {ghs(b.payoutFees)}.
        Earnings are your share after ELEMARKET commission; delivery fees are not included.
      </p>
      {Number(b.owedFromRefunds) > 0 ? (
        <p className="rounded-xl border border-market-line bg-market-soft p-3 text-sm sm:col-span-2 lg:col-span-5">
          {ghs(b.owedFromRefunds)} from customer refunds will be taken from your next released earnings.
        </p>
      ) : null}
    </section>
  );
}

function Withdraw({ wallet }: { wallet: Snapshot }) {
  const now = Date.now();
  const verified = wallet.destinations.filter((d) => d.status === "verified" && new Date(d.usableFrom).getTime() <= now);
  const active = wallet.payouts.find((p) => ["reserved", "processing", "under_review"].includes(p.status));
  const [amount, setAmount] = useState("");
  const [destinationId, setDestinationId] = useState(verified[0]?.id ?? "");
  const [quote, setQuote] = useState<{ amount: string; fee: string; netAmount: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const disabled = !wallet.payoutsConfigured || !verified.length || Boolean(active) || Number(wallet.balances.available) <= 0;

  async function review(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMessage(null);
    try { setQuote(await previewMerchantWithdrawal({ data: { merchantId: wallet.merchantId, amount, destinationId } })); }
    catch (err) { setMessage(safeError(err)); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!quote) return;
    setBusy(true); setMessage(null);
    try {
      const r = await requestMerchantWithdrawal({ data: { merchantId: wallet.merchantId, amount: quote.amount, destinationId, idempotencyKey } });
      setMessage(`Withdrawal of ${ghs(r.netAmount)} is ${STATUS_LABEL[r.status]?.toLowerCase() ?? r.status}.`);
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (err) { setMessage(safeError(err)); setBusy(false); }
  }

  return (
    <Card title="Withdraw">
      {active ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span>A withdrawal of {ghs(active.netAmount)} is {STATUS_LABEL[active.status]?.toLowerCase()}.</span>
          {active.cancellable ? <Button type="button" disabled={busy} className="border border-market-line bg-white" onClick={async () => {
            setBusy(true); setMessage(null);
            try { await cancelMerchantWithdrawal({ data: { merchantId: wallet.merchantId, payoutId: active.id } }); window.location.reload(); }
            catch (err) { setMessage(safeError(err)); setBusy(false); }
          }}>Cancel</Button> : null}
        </div>
      ) : null}
      <p className="mt-2 text-xs text-market-muted">Withdraw between {ghs(wallet.limits.minAmount)} and {ghs(wallet.limits.maxAmount)}, up to {wallet.limits.dailyCount} times a day.</p>
      {!wallet.payoutsConfigured ? <p className="mt-3 text-sm text-market-muted">Withdrawals are not switched on yet.</p> : null}
      {wallet.payoutsConfigured && !verified.length ? <p className="mt-3 text-sm text-market-muted">Add a payout account first.</p> : null}
      <form onSubmit={review} className="mt-4 grid gap-3">
        <label className="text-sm font-bold">Amount (GH₵)
          <input className="market-input mt-1 w-full rounded-xl border border-market-line px-3 py-2" inputMode="decimal" required
            value={amount} onChange={(e) => { setAmount(e.target.value); setQuote(null); }} disabled={disabled} placeholder={wallet.balances.available} />
        </label>
        <label className="text-sm font-bold">To
          <select className="market-input mt-1 w-full rounded-xl border border-market-line px-3 py-2" value={destinationId}
            onChange={(e) => { setDestinationId(e.target.value); setQuote(null); }} disabled={disabled}>
            {verified.map((d) => <option key={d.id} value={d.id}>{d.rail === "bank" ? "Bank" : "Mobile money"} {d.displayHint} · {d.accountName}</option>)}
          </select>
        </label>
        {!quote ? <Button type="submit" disabled={disabled || busy}>Review withdrawal</Button> : null}
      </form>
      {quote ? (
        <div className="mt-4 rounded-xl border border-market-line bg-market-soft p-3 text-sm">
          <p>Withdraw {ghs(quote.amount)} · Transfer fee {ghs(quote.fee)}</p>
          <p className="mt-1 font-black">You receive {ghs(quote.netAmount)}</p>
          <div className="mt-3 flex gap-2">
            <Button type="button" onClick={confirm} disabled={busy}>Confirm withdrawal</Button>
            <Button type="button" onClick={() => setQuote(null)} disabled={busy} className="border border-market-line bg-white">Change</Button>
          </div>
        </div>
      ) : null}
      {message ? <p role="status" aria-live="polite" className="mt-3 text-sm font-semibold">{message}</p> : null}
    </Card>
  );
}

function Destinations({ wallet }: { wallet: Snapshot }) {
  const [rail, setRail] = useState<"mobile_money" | "bank">("mobile_money");
  const [form, setForm] = useState({ accountNumber: "", institutionCode: "", accountName: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMessage(null);
    try {
      const r = await addMerchantPayoutDestination({ data: { merchantId: wallet.merchantId, rail, ...form } });
      setMessage(r.status === "verified" ? `Account verified${r.accountName ? ` for ${r.accountName}` : ""}.` : "Account added and waiting for provider verification.");
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (err) { setMessage(safeError(err)); setBusy(false); }
  }
  return (
    <Card title="Payout accounts">
      <ul className="mt-3 grid gap-2 text-sm">
        {wallet.destinations.length ? wallet.destinations.map((d) => (
          <li key={d.id} className="flex items-center justify-between rounded-xl border border-market-line px-3 py-2">
            <span>{d.rail === "bank" ? "Bank" : "Mobile money"} {d.displayHint} · {d.accountName}</span>
            <span className={`text-xs font-black ${d.status === "verified" ? "text-market-green" : "text-market-muted"}`}>
              {d.status !== "verified" ? "Pending" : new Date(d.usableFrom).getTime() > Date.now() ? `Usable from ${when(d.usableFrom)}` : "Verified"}
            </span>
          </li>
        )) : <li className="text-market-muted">No payout account yet.</li>}
      </ul>
      {wallet.payoutsConfigured ? (
        <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-bold sm:col-span-2">Type
            <select className="market-input mt-1 w-full rounded-xl border border-market-line px-3 py-2" value={rail} onChange={(e) => setRail(e.target.value as "mobile_money" | "bank")}>
              <option value="mobile_money">Mobile money</option><option value="bank">Bank account</option>
            </select>
          </label>
          <label className="text-sm font-bold">{rail === "bank" ? "Account number" : "Mobile number"}
            <input required className="market-input mt-1 w-full rounded-xl border border-market-line px-3 py-2" inputMode="tel" autoComplete="off"
              value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
          </label>
          <label className="text-sm font-bold">{rail === "bank" ? "Bank code" : "Network code"}
            <input required className="market-input mt-1 w-full rounded-xl border border-market-line px-3 py-2"
              value={form.institutionCode} onChange={(e) => setForm({ ...form, institutionCode: e.target.value })} />
          </label>
          <label className="text-sm font-bold sm:col-span-2">Account name
            <input required className="market-input mt-1 w-full rounded-xl border border-market-line px-3 py-2"
              value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} />
          </label>
          <Button type="submit" disabled={busy} className="border border-market-line bg-white sm:col-span-2">Add payout account</Button>
          <p className="text-xs text-market-muted sm:col-span-2">Only a provider token and the last 4 digits are kept by ELEMARKET.</p>
        </form>
      ) : null}
      {message ? <p role="status" aria-live="polite" className="mt-3 text-sm font-semibold">{message}</p> : null}
    </Card>
  );
}

function Withheld({ wallet }: { wallet: Snapshot }) {
  return (
    <Card title="Withheld sales">
      {wallet.withheldOrders.length ? (
        <ul className="mt-3 grid gap-2 text-sm">
          {wallet.withheldOrders.map((o) => (
            <li key={o.orderId} className="rounded-xl border border-market-line px-3 py-2">
              <div className="flex justify-between font-bold"><span className="truncate">Order {o.orderId.slice(-8)}</span><span>{ghs(o.amount)}</span></div>
              <p className="text-xs text-market-muted">{o.holdReason}{o.releasesAt && o.holdReason === "Return window open" ? ` · releases ${when(o.releasesAt)}` : ""}</p>
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm text-market-muted">Nothing is withheld.</p>}
    </Card>
  );
}

function Payouts({ wallet }: { wallet: Snapshot }) {
  return (
    <Card title="Withdrawals">
      {wallet.payouts.length ? (
        <ul className="mt-3 grid gap-2 text-sm">
          {wallet.payouts.map((p) => (
            <li key={p.id} className="rounded-xl border border-market-line px-3 py-2">
              <div className="flex justify-between font-bold"><span>{ghs(p.netAmount)} to {p.destination}</span><span className="text-xs">{STATUS_LABEL[p.status] ?? p.status}</span></div>
              <p className="text-xs text-market-muted">{when(p.createdAt)} · fee {ghs(p.fee)}{p.failureReason ? ` · ${p.failureReason}` : ""}</p>
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm text-market-muted">No withdrawals yet.</p>}
    </Card>
  );
}

function Ledger({ wallet }: { wallet: Snapshot }) {
  return (
    <Card title="Activity" className="lg:col-span-2">
      {wallet.ledger.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-market-muted"><tr><th className="py-2">When</th><th>What</th><th>Balance</th><th>Reference</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              {wallet.ledger.map((e) => (
                <tr key={e.id} className="border-t border-market-line">
                  <td className="py-2 whitespace-nowrap">{when(e.createdAt)}</td>
                  <td>{TYPE_LABEL[e.type] ?? e.type}</td>
                  <td>{BUCKET_LABEL[e.bucket] ?? e.bucket}</td>
                  <td className="text-xs text-market-muted">{e.orderId ? `Order ${e.orderId.slice(-8)}` : e.payoutId ? `Withdrawal ${e.payoutId.slice(-8)}` : ""}</td>
                  <td className={`text-right font-bold ${e.amount.startsWith("-") ? "text-market-orange" : "text-market-green"}`}>{e.amount.startsWith("-") ? "−" : "+"}{ghs(e.amount.replace("-", ""))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="mt-3 text-sm text-market-muted">No wallet activity yet.</p>}
    </Card>
  );
}
