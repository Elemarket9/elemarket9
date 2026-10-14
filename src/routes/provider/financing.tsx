import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  approveFinancingOffer,
  createFinancingOffer,
  loadFinancingPartnerDashboard,
  loadFinancingApplicationFormSubmission,
  recordFinancingDecision,
  recordFinancingServicingUpdate,
  updateFinancingCase,
} from "../../modules/financing/public/transport/partner.financing.functions";

export const Route = createFileRoute("/provider/financing")({
  loader: () => loadFinancingPartnerDashboard(),
  component: FinancingPartner,
  errorComponent: () => (
    <main className="mx-auto max-w-xl p-10 text-center">
      <h1 className="text-3xl font-black">Financing partner access required</h1>
      <p className="mt-3 text-market-muted">Sign in with an active financing-partner account.</p>
    </main>
  ),
});

const uid = () => crypto.randomUUID().replaceAll("-", "");
const closedStatuses = new Set(["completed", "declined", "cancelled"]);

function FinancingPartner() {
  const d = Route.useLoaderData();
  const apps = d.applications as any[];
  const cases = d.cases as any[];
  const offers = (d.offers ?? []) as any[];
  const [query, setQuery] = useState("");
  const [queue, setQueue] = useState("open");
  const [selected, setSelected] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [tenure, setTenure] = useState("6");
  const [submission, setSubmission] = useState<any | null>(null);
  const [submissionLoading, setSubmissionLoading] = useState(false);

  const rows = useMemo(
    () =>
      cases
        .map((c) => ({ ...c, app: apps.find(a => a.id === c.applicationId && a.audience === c.audience) }))
        .filter((c) => {
          const q = query.trim().toLowerCase();
          const open = !closedStatuses.has(c.workflowStatus);
          const matches =
            !q ||
            [c.id, c.applicationId, c.app?.merchantName, c.app?.providerName, c.app?.providerReference].some((v) =>
              String(v ?? "")
                .toLowerCase()
                .includes(q),
            );
          return (
            matches &&
            (queue === "all" ||
              (queue === "open" && open) ||
              (queue === "overdue" && open && new Date(c.slaDueAt).getTime() < Date.now()) ||
              queue === c.workflowStatus)
          );
        }),
    [cases, apps, query, queue],
  );

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      location.reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };

  const overdue = cases.filter(
    (c) => new Date(c.slaDueAt).getTime() < Date.now() && !closedStatuses.has(c.workflowStatus),
  ).length;
  const selectedPendingOffer = selected
    ? offers.find((o) => o.caseId === selected.id && o.status === "pending_supervisor")
    : null;
  const canSupervisorApprove = ["owner", "admin"].includes(String(d.role));

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <header className="rounded-3xl bg-market-ink p-6 text-white shadow-market-lg sm:p-8">
        <p className="text-xs font-black uppercase tracking-[.18em]">ELEMARKET Partner Hub · Financing</p>
        <h1 className="mt-2 text-3xl font-black">{d.organization}</h1>
        <p className="mt-2 text-sm text-neutral-300">
          Provider-owned underwriting workbench · ELEMARKET orchestrates, your organization decides
        </p>
      </header>

      {message ? (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">{message}</p>
      ) : null}

      <section className="mt-6 grid gap-3 sm:grid-cols-4">
        {[
          ["Applications", apps.length],
          ["Open cases", cases.filter((c) => !closedStatuses.has(c.workflowStatus)).length],
          ["Under review", cases.filter((c) => c.workflowStatus === "under_review").length],
          ["SLA overdue", overdue],
        ].map(([label, value]) => (
          <div className="rounded-2xl border border-market-line bg-white p-5" key={String(label)}>
            <p className="text-xs font-bold text-market-muted">{label}</p>
            <p className="mt-2 text-3xl font-black">{value}</p>
          </div>
        ))}
      </section>

      <section className="mt-6 rounded-2xl border border-market-line bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-black">Provider connections</h2>{d.capabilities?.includes("customer_financing") ? <Link to="/provider/financing-forms" className="rounded-xl bg-black px-4 py-2 text-xs font-black text-white">Build checkout application form</Link> : null}</div>
        <p className="mt-1 text-sm text-market-muted">
          Marketplace security and integration readiness remain visible before customer-facing operations.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {d.providers.map((p: any) => (
            <div className="rounded-xl border p-4" key={p.id}>
              <b>{p.name}</b>
              <p className="mt-1 text-xs text-market-muted">
                marketplace {p.marketplacePartnerStatus} · security {p.securityReviewStatus} · integration {p.integrationStatus} · commercial {p.commercialStatus}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6 rounded-2xl border border-market-line bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Manual / Hybrid / API workbench</h2>
            <h3 className="mt-1 font-black">Underwriting operations queue</h3>
            <p className="text-sm text-market-muted">
              Assignment, review, information requests, provider decisions, offers and servicing are executed here.
            </p>
          </div>
          <p className="text-xs font-bold text-market-muted">
            {d.providers.map((p: any) => `${p.name} · ${p.integrationMode}`).join(" | ")}
          </p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_220px]">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search case, applicant, provider or reference"
            className="rounded-xl border p-3 text-sm"
          />
          <select value={queue} onChange={(e) => setQueue(e.target.value)} className="rounded-xl border p-3 text-sm">
            <option value="open">Open cases</option>
            <option value="overdue">SLA overdue</option>
            <option value="all">All cases</option>
            {[
              "assigned",
              "under_review",
              "information_requested",
              "offer_issued",
              "awaiting_supervisor",
              "approved",
              "disbursed",
              "repaying",
              "completed",
              "declined",
              "cancelled",
            ].map((x) => (
              <option key={x} value={x}>
                {x.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[950px] text-left text-sm">
            <thead>
              <tr className="border-b">
                {["Case", "Audience", "Applicant", "Provider", "Amount", "Workflow", "Application", "SLA", ""].map((x) => (
                  <th className="p-3" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr className="border-b" key={c.id}>
                  <td className="p-3 font-bold">{c.id}</td>
                  <td className="p-3">{c.audience}</td>
                  <td className="p-3">{c.app?.merchantName ?? "Privacy scoped customer"}</td>
                  <td className="p-3">{c.app?.providerName ?? "—"}</td>
                  <td className="p-3">{c.app ? `${c.app.currency} ${Number(c.app.amount).toFixed(2)}` : "—"}</td>
                  <td className="p-3 font-bold">{c.workflowStatus.replaceAll("_", " ")}</td>
                  <td className="p-3">{c.app?.status ?? "—"}</td>
                  <td className={`p-3 text-xs ${new Date(c.slaDueAt).getTime() < Date.now() ? "font-black text-red-700" : ""}`}>
                    {new Date(c.slaDueAt).toLocaleString()}
                  </td>
                  <td className="p-3">
                    <button
                      onClick={() => {
                        setSelected(c);
                        setSubmission(null);
                        setText("");
                        setReference(c.app?.providerReference ?? "");
                        setAmount(String(c.app?.amount ?? ""));
                      }}
                      className="rounded-lg bg-black px-3 py-2 text-xs font-black text-white"
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? <p className="py-10 text-center text-market-muted">No cases match this queue.</p> : null}
        </div>
      </section>

      {selected ? (
        <section className="mt-6 rounded-2xl border border-market-line bg-white p-5">
          <div className="flex justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase text-market-muted">Provider case workbench</p>
              <h2 className="text-xl font-black">
                {selected.id} · {selected.app?.providerName}
              </h2>
              <p className="text-sm text-market-muted">
                {selected.audience} · {selected.app?.currency} {Number(selected.app?.amount ?? 0).toFixed(2)} · v{selected.version}
              </p>
            </div>
            <button onClick={() => setSelected(null)} className="text-sm font-black">
              Close
            </button>
          </div>

          {selected.audience === "customer" ? <div className="mt-5 rounded-2xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-black">Customer application requirements</h3><p className="text-xs text-market-muted">Initial deposit: {selected.app?.initialDepositAmount ? `GHS ${Number(selected.app.initialDepositAmount).toFixed(2)} · ${selected.app.initialDepositStatus}` : "not required"}</p></div>{selected.app?.providerFormId ? <button type="button" disabled={submissionLoading} onClick={()=>{setSubmissionLoading(true);void loadFinancingApplicationFormSubmission({data:{applicationId:selected.applicationId}}).then(setSubmission).catch(e=>setMessage(e instanceof Error?e.message:"Could not load application form")).finally(()=>setSubmissionLoading(false))}} className="rounded-xl border px-3 py-2 text-xs font-black">{submissionLoading?"Loading…":"View submitted form"}</button>:<span className="text-xs text-market-muted">No provider form attached</span>}</div>
            {submission ? <div className="mt-4 grid gap-3 md:grid-cols-2">{submission.answers.map((a:any)=><div key={a.fieldKey} className="rounded-xl bg-market-soft p-3"><p className="text-xs font-black text-market-muted">{a.label}</p>{a.downloadUrl?<a href={a.downloadUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-sm font-black text-market-green">Open secure file (5 min) →</a>:<p className="mt-1 break-words text-sm font-semibold">{a.answerText || "—"}</p>}</div>)}</div>:null}
          </div> : null}

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border p-4">
              <h3 className="font-black">Case handling</h3>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Information request or internal note"
                className="mt-3 min-h-24 w-full rounded-xl border p-3 text-sm"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  disabled={busy}
                  onClick={() => void run(() => updateFinancingCase({ data: { action: "assign", caseId: selected.id, assigneeUserId: "self", expectedVersion: selected.version } }))}
                  className="rounded-xl border px-3 py-2 text-xs font-black disabled:opacity-40"
                >
                  Assign to me
                </button>
                <button
                  disabled={busy}
                  onClick={() => void run(() => updateFinancingCase({ data: { action: "start_review", caseId: selected.id, expectedVersion: selected.version } }))}
                  className="rounded-xl border px-3 py-2 text-xs font-black disabled:opacity-40"
                >
                  Start review
                </button>
                <button
                  disabled={busy || text.trim().length < 3}
                  onClick={() => void run(() => updateFinancingCase({ data: { action: "request_information", caseId: selected.id, requestText: text, expectedVersion: selected.version } }))}
                  className="rounded-xl border px-3 py-2 text-xs font-black disabled:opacity-40"
                >
                  Request information
                </button>
                <button
                  disabled={busy || !text.trim()}
                  onClick={() => void run(() => updateFinancingCase({ data: { action: "add_note", caseId: selected.id, note: text, expectedVersion: selected.version } }))}
                  className="rounded-xl border px-3 py-2 text-xs font-black disabled:opacity-40"
                >
                  Internal note
                </button>
              </div>
            </div>

            <div className="rounded-2xl border p-4">
              <h3 className="font-black">Provider decision</h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Provider reference" className="rounded-xl border p-3 text-sm" />
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Approved amount" className="rounded-xl border p-3 text-sm" />
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  disabled={busy || !reference || !(Number(amount) > 0)}
                  onClick={() =>
                    void run(() =>
                      recordFinancingDecision({
                        data: {
                          applicationId: selected.applicationId,
                          audience: selected.audience,
                          decision: "approved",
                          providerReference: reference,
                          approvedAmount: Number(amount),
                          idempotencyKey: `approve_${uid()}`,
                        },
                      }),
                    )
                  }
                  className="rounded-xl bg-black px-4 py-2 text-xs font-black text-white disabled:opacity-40"
                >
                  Approve
                </button>
                <button
                  disabled={busy || !reference}
                  onClick={() =>
                    void run(() =>
                      recordFinancingDecision({
                        data: {
                          applicationId: selected.applicationId,
                          audience: selected.audience,
                          decision: "declined",
                          providerReference: reference,
                          reasonCode: text.trim() || undefined,
                          idempotencyKey: `decline_${uid()}`,
                        },
                      }),
                    )
                  }
                  className="rounded-xl border border-red-300 px-4 py-2 text-xs font-black text-red-700 disabled:opacity-40"
                >
                  Decline
                </button>
              </div>
            </div>

            <div className="rounded-2xl border p-4">
              <h3 className="font-black">Offer</h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Offer amount" className="rounded-xl border p-3 text-sm" />
                <input value={tenure} onChange={(e) => setTenure(e.target.value)} inputMode="numeric" placeholder="Tenure months" className="rounded-xl border p-3 text-sm" />
              </div>
              <button
                disabled={busy || !(Number(amount) > 0)}
                onClick={() =>
                  void run(() =>
                    createFinancingOffer({
                      data: {
                        caseId: selected.id,
                        amount: Number(amount),
                        currency: selected.app?.currency ?? "GHS",
                        tenureMonths: Number(tenure) || undefined,
                        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
                        providerTerms: { source: "partner_dashboard" },
                        expectedVersion: selected.version,
                      },
                    }),
                  )
                }
                className="mt-3 rounded-xl bg-black px-4 py-2 text-xs font-black text-white disabled:opacity-40"
              >
                Issue offer
              </button>
              {selectedPendingOffer ? (
                <div className="mt-3 rounded-xl border bg-market-soft p-3 text-xs">
                  <p className="font-black">Supervisor approval required</p>
                  <p className="mt-1 text-market-muted">
                    {selectedPendingOffer.currency} {Number(selectedPendingOffer.amount).toFixed(2)} · expires {new Date(selectedPendingOffer.expiresAt).toLocaleString()}
                  </p>
                  {canSupervisorApprove ? (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          approveFinancingOffer({
                            data: {
                              offerId: selectedPendingOffer.id,
                              caseId: selected.id,
                              expectedVersion: selected.version,
                            },
                          }),
                        )
                      }
                      className="mt-2 rounded-lg bg-black px-3 py-2 font-black text-white disabled:opacity-40"
                    >
                      Approve offer as supervisor
                    </button>
                  ) : (
                    <p className="mt-2 font-bold">An owner or partner admin must approve this offer.</p>
                  )}
                </div>
              ) : null}
            </div>

            <div className="rounded-2xl border p-4">
              <h3 className="font-black">Servicing</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {["purchase_authorized", "disbursed", "repayment_current", "repayment_late", "repayment_completed", "cancelled"].map((u) => (
                  <button
                    disabled={busy}
                    key={u}
                    onClick={() =>
                      void run(() =>
                        recordFinancingServicingUpdate({
                          data: {
                            caseId: selected.id,
                            updateType: u as "purchase_authorized" | "disbursed" | "repayment_current" | "repayment_late" | "repayment_completed" | "cancelled",
                            providerReference: reference || undefined,
                            effectiveAt: new Date().toISOString(),
                            idempotencyKey: `service_${uid()}`,
                          },
                        }),
                      )
                    }
                    className="rounded-xl border px-3 py-2 text-xs font-black disabled:opacity-40"
                  >
                    {u.replaceAll("_", " ")}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
