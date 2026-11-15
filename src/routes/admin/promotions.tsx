import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import type { MarketplacePromotionRow, MerchantPromotionRow, PromotionScopeOptions } from "@/modules/administration/public/admin-promotions.types";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import {
  createAdminMarketplacePromotion,
  loadAdminPromotions,
  pauseAdminMarketplacePromotion,
  pauseAdminMerchantPromotion,
  resumeAdminMarketplacePromotion,
  resumeAdminMerchantPromotion,
  updateAdminMarketplacePromotion,
} from "@/modules/administration/public/transport/admin/promotions.functions";

export const Route = createFileRoute("/admin/promotions")({
  head: () => ({ meta: [{ title: "Deals & promotions | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  loader: async () => {
    const access = await getAdminAccessState();
    if (!(access.staffRole === "owner" || access.capabilities.includes("admin.promotions.manage"))) throw redirect({ to: "/admin" });
    const data = await loadAdminPromotions({ data: {} });
    return { access, ...data };
  },
  component: Promotions,
  errorComponent: () => (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl font-black">Promotions access required</h1>
      <p className="mt-3 text-sm text-market-muted">Ask the Main Administrator for the “Deals & promotions” permission.</p>
    </main>
  ),
});

type Marketplace = MarketplacePromotionRow;
type MerchantPromo = MerchantPromotionRow;
type Data = { marketplace: Marketplace[]; merchant: MerchantPromo[]; scope: PromotionScopeOptions };
type Run = (key: string, fn: () => Promise<string>) => Promise<void>;

const ghs = (v: string | number) => `GH₵ ${Number(v).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (v: string | Date | null) => (v ? new Date(v).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" }) : "—");
const toLocalInput = (v: string | Date) => {
  const d = new Date(v);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const PHASE_STYLE: Record<string, string> = {
  live: "bg-green-50 text-green-800", scheduled: "bg-blue-50 text-blue-800", draft: "bg-market-soft text-market-muted",
  paused: "bg-amber-50 text-amber-900", ended: "bg-market-soft text-market-muted", archived: "bg-market-soft text-market-muted",
};
const discountLabel = (p: { discount_type: string; discount_value: string; max_discount: string | null }) =>
  p.discount_type === "percentage"
    ? `${Number(p.discount_value)}% off${p.max_discount ? ` (up to ${ghs(p.max_discount)})` : ""}`
    : `${ghs(p.discount_value)} off`;

function errorText(e: unknown) {
  const m = e instanceof Error ? e.message : "";
  if (/fresh/i.test(m)) return "Please sign in again before changing promotions.";
  if (/forbidden|permission/i.test(m)) return "You don't have the permission this needs.";
  if (/rate|too many/i.test(m)) return "Too many changes in a short time. Wait a few minutes and try again.";
  return m || "That did not work. Please try again.";
}

function Panel({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6 rounded-2xl border border-market-line bg-white p-5">
      <h2 className="text-xl font-black">{title}</h2>
      {intro ? <p className="mt-1 text-sm text-market-muted">{intro}</p> : null}
      {children}
    </section>
  );
}

function Promotions() {
  const { access, marketplace, merchant, scope } = Route.useLoaderData();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Marketplace | null>(null);
  const [creating, setCreating] = useState(false);
  const run: Run = async (key, fn) => {
    setBusy(key); setMessage(null);
    try { setMessage({ kind: "ok", text: await fn() }); window.setTimeout(() => window.location.reload(), 1200); }
    catch (e) { setMessage({ kind: "error", text: errorText(e) }); setBusy(null); }
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
      <header className="rounded-3xl border border-market-line bg-white p-6">
        <p className="text-xs font-black uppercase tracking-widest text-market-muted">Marketing controls</p>
        <h1 className="mt-2 text-3xl font-black">Deals & promotions</h1>
        <p className="mt-2 text-sm text-market-muted">
          Marketplace promotions are paid for by ELEMARKET. The customer pays less, and the discount comes out of ELEMARKET's
          commission on that order — merchants are paid exactly what they would be paid without the promotion. On each order the
          discount is limited to ELEMARKET's commission on that order, and a promotion stops when its budget is used up.
          One promo code per checkout.
        </p>
      </header>
      {message ? (
        <p role={message.kind === "error" ? "alert" : "status"} className={`mt-5 rounded-xl p-4 text-sm ${message.kind === "error" ? "bg-red-50 text-red-800" : "bg-green-50 text-green-900"}`}>{message.text}</p>
      ) : null}

      <Panel title={`Marketplace promotions (${marketplace.length})`} intro="Codes customers enter at checkout. Funded by ELEMARKET.">
        <div className="mt-4">
          {creating ? (
            <PromotionForm scope={scope} busy={busy} run={run} onCancel={() => setCreating(false)} />
          ) : (
            <button type="button" className="rounded-xl bg-market-green px-4 py-2 text-sm font-black text-white" onClick={() => { setEditing(null); setCreating(true); }}>
              New marketplace promotion
            </button>
          )}
        </div>
        {marketplace.length ? (
          <ul className="mt-5 grid gap-3">
            {marketplace.map((p) => editing?.id === p.id ? (
              <li key={p.id}><PromotionForm scope={scope} busy={busy} run={run} existing={p} onCancel={() => setEditing(null)} /></li>
            ) : (
              <MarketplaceCard key={p.id} p={p} busy={busy} run={run} onEdit={() => { setCreating(false); setEditing(p); }} />
            ))}
          </ul>
        ) : <p className="mt-4 text-sm text-market-muted">No marketplace promotions yet.</p>}
      </Panel>

      <MerchantPromotions rows={merchant} busy={busy} run={run} />
    </main>
  );
}

function ReasonAction({ label, busy, onConfirm, tone = "plain" }: { label: string; busy: boolean; onConfirm: (reason: string) => void; tone?: "plain" | "warn" }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)}
        className={`rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50 ${tone === "warn" ? "border border-amber-300 bg-amber-50 text-amber-900" : "border border-market-line bg-white"}`}>
        {label}
      </button>
    );
  }
  return (
    <div className="flex w-full flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 text-sm font-bold">Reason (recorded in the audit history)
        <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={500} className="mt-1 w-full rounded-xl border border-market-line p-2 font-normal" placeholder="e.g. Fraud pattern under review" />
      </label>
      <button type="button" disabled={busy || reason.trim().length < 5} onClick={() => onConfirm(reason.trim())}
        className="rounded-xl bg-market-green px-4 py-2 text-sm font-black text-white disabled:opacity-50">{label}</button>
      <button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-market-line px-4 py-2 text-sm font-bold">Cancel</button>
    </div>
  );
}

function MarketplaceCard({ p, busy, run, onEdit }: { p: Marketplace; busy: string | null; run: Run; onEdit: () => void }) {
  const budget = Number(p.budget);
  const usedPct = budget > 0 ? Math.min(100, ((Number(p.budget_consumed) + Number(p.budget_reserved)) / budget) * 100) : 0;
  const canResume = (p.status === "paused" || p.status === "draft") && p.phase !== "ended";
  return (
    <li className="rounded-xl border border-market-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-black">{p.name} <span className="ml-1 rounded-lg bg-market-soft px-2 py-0.5 font-mono text-xs">{p.code}</span></p>
          <p className="mt-1 text-sm">{discountLabel(p)}{Number(p.min_subtotal) > 0 ? ` · minimum basket ${ghs(p.min_subtotal)}` : ""}{p.first_order_only ? " · first order only" : ""}</p>
          <p className="mt-1 text-xs text-market-muted">
            {when(p.starts_at)} → {when(p.ends_at)} · {p.per_customer_limit} use{p.per_customer_limit === 1 ? "" : "s"} per customer
            {p.usage_limit ? ` · ${p.usage_limit} uses in total` : ""}
            {p.categories.length ? ` · categories: ${p.categories.join(", ")}` : ""}
            {p.merchant_ids.length ? ` · ${p.merchant_ids.length} merchant${p.merchant_ids.length === 1 ? "" : "s"} only` : ""}
            {p.is_public ? " · shown on Deals page" : ""}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-black ${PHASE_STYLE[p.phase] ?? ""}`}>{p.phase}</span>
      </div>
      <div className="mt-3">
        <div className="h-2 overflow-hidden rounded-full bg-market-soft" aria-hidden="true"><div className="h-full bg-market-green" style={{ width: `${usedPct}%` }} /></div>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          <div><dt className="text-market-muted">Budget</dt><dd className="font-bold">{ghs(p.budget)}</dd></div>
          <div><dt className="text-market-muted">Spent (paid orders)</dt><dd className="font-bold">{ghs(p.budget_consumed)}</dd></div>
          <div><dt className="text-market-muted">Held (awaiting payment)</dt><dd className="font-bold">{ghs(p.budget_reserved)}</dd></div>
          <div><dt className="text-market-muted">Remaining</dt><dd className="font-bold">{ghs(p.budget_remaining)}</dd></div>
          <div><dt className="text-market-muted">Redemptions</dt><dd className="font-bold">{p.redemptions_applied} paid · {p.redemptions_reserved} pending · {p.redemptions_released} released</dd></div>
        </dl>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {p.phase !== "ended" && p.phase !== "archived" ? (
          <button type="button" disabled={busy !== null} onClick={onEdit} className="rounded-xl border border-market-line bg-white px-4 py-2 text-sm font-bold disabled:opacity-50">
            {new Date(p.starts_at).getTime() > Date.now() ? "Edit" : "Shorten or add budget"}
          </button>
        ) : null}
        {p.status === "active" && p.phase !== "ended" ? (
          <ReasonAction label="Pause" tone="warn" busy={busy !== null} onConfirm={(reason) => void run(p.id, async () => {
            await pauseAdminMarketplacePromotion({ data: { promotionId: p.id, reason } }); return "Promotion paused. Customers can no longer use the code.";
          })} />
        ) : null}
        {canResume ? (
          <ReasonAction label={p.status === "draft" ? "Activate" : "Resume"} busy={busy !== null} onConfirm={(reason) => void run(p.id, async () => {
            await resumeAdminMarketplacePromotion({ data: { promotionId: p.id, reason } }); return p.status === "draft" ? "Promotion activated." : "Promotion resumed.";
          })} />
        ) : null}
      </div>
    </li>
  );
}

function PromotionForm({ scope, busy, run, existing, onCancel }: {
  scope: Data["scope"]; busy: string | null; run: Run; existing?: Marketplace; onCancel: () => void;
}) {
  const started = existing ? new Date(existing.starts_at).getTime() <= Date.now() : false;
  const now = Date.now();
  const [f, setF] = useState({
    code: existing?.code ?? "",
    name: existing?.name ?? "",
    description: existing?.description ?? "",
    discountType: (existing?.discount_type ?? "percentage") as "percentage" | "fixed",
    discountValue: existing ? String(Number(existing.discount_value)) : "",
    maxDiscount: existing?.max_discount ? String(Number(existing.max_discount)) : "",
    minSubtotal: existing ? String(Number(existing.min_subtotal)) : "0",
    usageLimit: existing?.usage_limit ? String(existing.usage_limit) : "",
    perCustomerLimit: String(existing?.per_customer_limit ?? 1),
    startsAt: toLocalInput(existing?.starts_at ?? new Date(now + 3_600_000)),
    endsAt: toLocalInput(existing?.ends_at ?? new Date(now + 7 * 86_400_000)),
    budget: existing ? String(Number(existing.budget)) : "",
    firstOrderOnly: existing?.first_order_only ?? false,
    isPublic: existing?.is_public ?? false,
    categories: existing?.categories ?? [],
    merchantIds: existing?.merchant_ids ?? [],
    activate: false,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const locked = started;
  const field = "mt-1 h-11 w-full rounded-xl border border-market-line px-3 font-normal disabled:bg-market-soft";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const payload = {
      code: f.code.trim().toUpperCase(), name: f.name.trim(), description: f.description.trim() || null,
      discountType: f.discountType, discountValue: f.discountValue.trim(), maxDiscount: f.maxDiscount.trim() || null,
      minSubtotal: f.minSubtotal.trim() || "0", usageLimit: f.usageLimit.trim() ? Number(f.usageLimit) : null,
      perCustomerLimit: Number(f.perCustomerLimit), budget: f.budget.trim(),
      // Unchanged dates are sent back exactly as stored so a started promotion is not seen as edited.
      startsAt: existing && f.startsAt === toLocalInput(existing.starts_at) ? new Date(existing.starts_at).toISOString() : new Date(f.startsAt).toISOString(),
      endsAt: existing && f.endsAt === toLocalInput(existing.ends_at) ? new Date(existing.ends_at).toISOString() : new Date(f.endsAt).toISOString(),
      firstOrderOnly: f.firstOrderOnly, isPublic: f.isPublic, categories: f.categories, merchantIds: f.merchantIds,
    };
    void run(existing?.id ?? "new", async () => {
      if (existing) {
        await updateAdminMarketplacePromotion({ data: { ...payload, promotionId: existing.id } });
        return "Promotion updated.";
      }
      await createAdminMarketplacePromotion({ data: { ...payload, activate: f.activate } });
      return f.activate ? "Promotion created and approved to run in its window." : "Promotion saved as a draft.";
    });
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-market-line bg-market-soft/40 p-4">
      <h3 className="text-lg font-black">{existing ? (started ? `Change “${existing.name}”` : `Edit “${existing.name}”`) : "New marketplace promotion"}</h3>
      {started ? <p className="mt-1 text-sm text-market-muted">This promotion has started. You can only bring the end date forward or increase the budget. To stop it now, pause it.</p> : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-bold">Code customers type
          <input required disabled={locked} value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 64))} minLength={4} className={`${field} font-mono`} placeholder="WEEKEND10" />
        </label>
        <label className="text-sm font-bold">Name
          <input required disabled={locked} value={f.name} onChange={(e) => set("name", e.target.value)} minLength={2} maxLength={160} className={field} placeholder="Weekend 10% off" />
        </label>
        <label className="text-sm font-bold sm:col-span-2">Description for customers <span className="font-normal text-market-muted">(optional)</span>
          <input disabled={locked} value={f.description} onChange={(e) => set("description", e.target.value)} maxLength={500} className={field} />
        </label>
        <label className="text-sm font-bold">Discount type
          <select disabled={locked} value={f.discountType} onChange={(e) => set("discountType", e.target.value as "percentage" | "fixed")} className={field}>
            <option value="percentage">Percentage off</option>
            <option value="fixed">Fixed amount off (GH₵)</option>
          </select>
        </label>
        <label className="text-sm font-bold">{f.discountType === "percentage" ? "Percentage (1–100)" : "Amount off (GH₵)"}
          <input required disabled={locked} inputMode="decimal" value={f.discountValue} onChange={(e) => set("discountValue", e.target.value)} className={field} />
        </label>
        <label className="text-sm font-bold">Maximum discount per order (GH₵) <span className="font-normal text-market-muted">(optional)</span>
          <input disabled={locked} inputMode="decimal" value={f.maxDiscount} onChange={(e) => set("maxDiscount", e.target.value)} className={field} />
        </label>
        <label className="text-sm font-bold">Minimum basket (GH₵)
          <input disabled={locked} inputMode="decimal" value={f.minSubtotal} onChange={(e) => set("minSubtotal", e.target.value)} className={field} />
        </label>
        <label className="text-sm font-bold">Uses per customer
          <input required disabled={locked} type="number" min={1} max={100} value={f.perCustomerLimit} onChange={(e) => set("perCustomerLimit", e.target.value)} className={field} />
        </label>
        <label className="text-sm font-bold">Total uses <span className="font-normal text-market-muted">(optional)</span>
          <input disabled={locked} type="number" min={1} value={f.usageLimit} onChange={(e) => set("usageLimit", e.target.value)} className={field} />
        </label>
        <label className="text-sm font-bold">Starts
          <input required disabled={locked} type="datetime-local" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} className={field} />
        </label>
        <label className="text-sm font-bold">Ends
          <input required type="datetime-local" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} className={field} />
        </label>
        <label className="text-sm font-bold">Total budget (GH₵)
          <input required inputMode="decimal" value={f.budget} onChange={(e) => set("budget", e.target.value)} className={field} />
          <span className="mt-1 block text-xs font-normal text-market-muted">The most ELEMARKET will spend. Codes stop working when it is used up.</span>
        </label>
        <div className="grid content-start gap-2 text-sm font-bold">
          <label className="flex items-center gap-2"><input type="checkbox" disabled={locked} checked={f.firstOrderOnly} onChange={(e) => set("firstOrderOnly", e.target.checked)} /> First order only</label>
          <label className="flex items-center gap-2"><input type="checkbox" disabled={locked} checked={f.isPublic} onChange={(e) => set("isPublic", e.target.checked)} /> Show on the public Deals page</label>
          {!existing ? <label className="flex items-center gap-2"><input type="checkbox" checked={f.activate} onChange={(e) => set("activate", e.target.checked)} /> Approve now (runs automatically from the start time)</label> : null}
        </div>
        <fieldset className="text-sm font-bold sm:col-span-2" disabled={locked}>
          <legend>Categories <span className="font-normal text-market-muted">(none selected = every category)</span></legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {scope.categories.map((c) => (
              <label key={c.key} className="flex items-center gap-1 rounded-lg border border-market-line bg-white px-2 py-1 font-normal">
                <input type="checkbox" checked={f.categories.includes(c.key)} onChange={(e) => set("categories", e.target.checked ? [...f.categories, c.key] : f.categories.filter((x) => x !== c.key))} />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-sm font-bold sm:col-span-2">Limit to merchants <span className="font-normal text-market-muted">(none selected = every merchant; hold Ctrl/⌘ to pick several)</span>
          <select multiple disabled={locked} value={f.merchantIds} onChange={(e) => set("merchantIds", Array.from(e.target.selectedOptions, (o) => o.value))} className="mt-1 h-32 w-full rounded-xl border border-market-line p-2 font-normal disabled:bg-market-soft">
            {scope.merchants.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" disabled={busy !== null} className="rounded-xl bg-market-green px-4 py-2 text-sm font-black text-white disabled:opacity-50">
          {busy ? "Saving…" : existing ? "Save changes" : "Create promotion"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-xl border border-market-line bg-white px-4 py-2 text-sm font-bold">Cancel</button>
      </div>
    </form>
  );
}

function MerchantPromotions({ rows, busy, run }: { rows: MerchantPromo[]; busy: string | null; run: Run }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((r) => [r.name, r.code ?? "", r.merchant_name ?? ""].some((v) => v.toLowerCase().includes(q))) : rows;
  return (
    <Panel title={`Merchant promotions (${rows.length})`}
      intro="Coupons and flash sales run and paid for by merchants. You can pause one (with a reason) but not change its terms. Only an administrator can lift that pause.">
      <label className="mt-4 block text-sm font-bold">Search
        <input value={query} onChange={(e) => setQuery(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-market-line px-3 font-normal sm:max-w-sm" placeholder="Merchant, name or code" />
      </label>
      {shown.length ? (
        <ul className="mt-4 grid gap-3">
          {shown.map((r) => {
            const ended = new Date(r.ends_at).getTime() <= Date.now();
            const pausable = !r.admin_paused_at && !ended && (r.status === "active" || (r.kind === "flash_sale" && r.status === "scheduled"));
            return (
              <li key={`${r.kind}:${r.id}`} className="rounded-xl border border-market-line p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-black">{r.name}{r.code ? <span className="ml-2 rounded-lg bg-market-soft px-2 py-0.5 font-mono text-xs">{r.code}</span> : null}</p>
                    <p className="mt-1 text-xs text-market-muted">
                      {r.kind === "flash_sale" ? "Flash sale" : "Coupon"} · {r.merchant_name ?? "All participating merchants (merchant-funded)"} · {when(r.starts_at)} → {when(r.ends_at)}
                    </p>
                    <p className="mt-1 text-xs">{r.redemptions_applied} paid · {r.redemptions_reserved} pending · discount given {ghs(r.discount_given)}</p>
                    {r.admin_paused_at ? <p className="mt-1 text-xs font-semibold text-amber-900">Paused by ELEMARKET on {when(r.admin_paused_at)}: “{r.admin_pause_reason}”</p> : null}
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-black ${r.admin_paused_at ? "bg-amber-50 text-amber-900" : ended ? "bg-market-soft text-market-muted" : "bg-market-soft"}`}>{ended ? "ended" : r.status}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {pausable ? (
                    <ReasonAction label="Pause" tone="warn" busy={busy !== null} onConfirm={(reason) => void run(r.id, async () => {
                      await pauseAdminMerchantPromotion({ data: { kind: r.kind, id: r.id, reason } }); return "Paused. The merchant cannot restart it.";
                    })} />
                  ) : null}
                  {r.admin_paused_at && !ended ? (
                    <ReasonAction label="Resume" busy={busy !== null} onConfirm={(reason) => void run(r.id, async () => {
                      await resumeAdminMerchantPromotion({ data: { kind: r.kind, id: r.id, reason } }); return "Resumed.";
                    })} />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : <p className="mt-4 text-sm text-market-muted">{q ? "No matches." : "No merchant promotions."}</p>}
    </Panel>
  );
}
