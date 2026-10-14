import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { loadAdminDashboard, requestAdminProviderRefund, setCatalogTaxonomyState, viewMerchantSensitiveData, type AdminDashboardData } from "../../modules/administration/public/transport/admin/dashboard.functions";
import { getAdminAccessState } from "../../modules/administration/public/transport/admin/access.functions";
import { reviewMerchantApplication } from "../../modules/merchants/public/transport/admin/merchant-review.functions";
import { loadAdminModeration, moderateCustomer, moderateMerchant, moderateProduct, setMerchantEnterpriseMode, type AdminModerationData } from "../../modules/administration/public/transport/admin/moderation.functions";
import { loadCommissionPolicy, removeCommissionOverride, setCommissionRule, setGlobalCommissionRule, type AdminCommissionData } from "../../modules/administration/public/transport/admin/fee.functions";
import { AdminSupportWorkspace } from "@/components/admin-support-workspace";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";

type AdminDashboardPageData = AdminDashboardData & { moderation: AdminModerationData; commission: AdminCommissionData };

export const Route = createFileRoute("/admin/dashboard")({
  head: () => ({ meta: [{ title: "Operations dashboard | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  loader: async (): Promise<AdminDashboardPageData> => {
    const access = await getAdminAccessState();
    if (!access.authenticated || !access.isAdmin) {
      throw redirect({ to: "/admin" });
    }
    if (access.staffRole !== "owner") throw redirect({ to: "/admin" });
    const [dashboard, moderation, commission] = await Promise.all([loadAdminDashboard(), loadAdminModeration(), loadCommissionPolicy()]);
    return { ...dashboard, moderation, commission };
  },
  component: Dashboard,
  errorComponent: () => (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl font-black">Admin access required</h1>
      <p className="mt-3 text-sm text-market-muted">This area is restricted to authorized operations administrators.</p>
    </main>
  ),
});

const metricLabels: Array<[keyof AdminDashboardData["metrics"], string]> = [
  ["merchantReviews", "Merchant reviews"],
  ["pendingPayments", "Payment attempts pending"],
  ["rejectedWebhooks24h", "Rejected webhooks / 24h"],
  ["errors24h", "Errors / 24h"],
  ["activeMerchants", "Active merchants"],
  ["refundExceptions", "Refund exceptions"],
  ["ordersToday", "Orders today"],
  ["overdueMerchantReviews", "Merchant reviews overdue"],
  ["stalePaymentAttempts", "Stale payment attempts"],
  ["openRiskFlags", "Open fraud/risk flags"],
  ["pendingProviderApplications", "Provider applications pending"],
];

function VerificationBadge({ label, status }: { label: string; status: string }) {
  const good = status === "verified";
  return (
    <span className={`rounded-full border px-2 py-1 text-[11px] font-bold ${good ? "border-green-200 bg-green-50 text-green-700" : "border-market-line bg-market-soft text-market-muted"}`}>
      {label}: {status.replaceAll("_", " ")}
    </span>
  );
}

function Dashboard() {
  const data = Route.useLoaderData();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sensitiveById, setSensitiveById] = useState<Record<string, { businessNumber: string; taxpayerIdType: string; taxpayerId: string; businessType: string; taxRegistrationStatus: string; vatRegistrationStatus: string | null }>>({});
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [manualLocationById, setManualLocationById] = useState<Record<string, { enabled: boolean; latitude: string; longitude: string; city: string; neighborhood: string; justification: string }>>({});
  function setLocationField(applicationId: string, field: "enabled" | "latitude" | "longitude" | "city" | "neighborhood" | "justification", value: string | boolean) {
    setManualLocationById(current => ({ ...current, [applicationId]: {
      ...(current[applicationId] ?? { enabled: false, latitude: "", longitude: "", city: "", neighborhood: "", justification: "" }), [field]: value,
    } }));
  }
  const [message, setMessage] = useState<string | null>(null);
  const [refundBusyId, setRefundBusyId] = useState<string | null>(null);
  const [refundNoteByOrderId, setRefundNoteByOrderId] = useState<Record<string, string>>({});
  const [moderationReason, setModerationReason] = useState<Record<string, string>>({});
  const [commissionBusy, setCommissionBusy] = useState(false);
  const [commissionReason, setCommissionReason] = useState("");
  const [globalCommission, setGlobalCommission] = useState("");
  const [overrideType, setOverrideType] = useState<"category" | "merchant" | "product">("category");
  const [overrideId, setOverrideId] = useState("");
  const [overrideRate, setOverrideRate] = useState("");
  const [moderationBusy, setModerationBusy] = useState<string | null>(null);
  const [taxonomyBusy, setTaxonomyBusy] = useState<string | null>(null);
  const [taxonomyReason, setTaxonomyReason] = useState<Record<string,string>>({});

  async function setTaxonomyState(scope: "category" | "subcategory", categoryKey: string, subcategoryKey: string | null, active: boolean) {
    const id = scope === "category" ? categoryKey : `${categoryKey}:${subcategoryKey}`;
    const reason = taxonomyReason[id]?.trim();
    if (!reason || reason.length < 5) { setMessage("A reason of at least 5 characters is required for catalogue availability changes."); return; }
    setTaxonomyBusy(id); setMessage(null);
    try {
      await setCatalogTaxonomyState({ data: { scope, categoryKey, subcategoryKey, active, reason } });
      window.location.reload();
    } catch { setMessage("Catalogue availability change failed. Refresh and try again."); }
    finally { setTaxonomyBusy(null); }
  }

  async function setEnterpriseMode(merchantId: string, enable: boolean) {
    const reason = moderationReason[`merchant-enterprise:${merchantId}`]?.trim();
    if (!reason || reason.length < 12) { setMessage("Enterprise-mode changes require a justification of at least 12 characters."); return; }
    setModerationBusy(`merchant-enterprise:${merchantId}`); setMessage(null);
    try { await setMerchantEnterpriseMode({ data: { merchantId, action: enable ? "enable" : "disable", reason } }); window.location.reload(); }
    catch { setMessage("Enterprise-mode change failed."); }
    finally { setModerationBusy(null); }
  }

  async function moderateMerchantAccount(merchantId: string, action: "suspend" | "reinstate") {
    const reason = moderationReason[`merchant:${merchantId}`]?.trim();
    if (!reason || reason.length < 10) { setMessage("A moderation reason of at least 10 characters is required."); return; }
    setModerationBusy(`merchant:${merchantId}`); setMessage(null);
    try { await moderateMerchant({ data: { merchantId, action, reason } }); window.location.reload(); }
    catch { setMessage("Merchant moderation failed. Verify the merchant state and try again."); }
    finally { setModerationBusy(null); }
  }

  async function moderateProductListing(productId: string, action: "approve" | "suspend" | "archive") {
    const reason = moderationReason[`product:${productId}`]?.trim();
    if (!reason || reason.length < 10) { setMessage("Product moderation requires a justification of at least 10 characters."); return; }
    setModerationBusy(`product:${productId}`); setMessage(null);
    try { await moderateProduct({ data: { productId, action, reason } }); window.location.reload(); }
    catch { setMessage("Product moderation failed."); }
    finally { setModerationBusy(null); }
  }

  async function moderateCustomerAccount(userId: string, action: "blacklist" | "unblacklist") {
    const reason = moderationReason[`customer:${userId}`]?.trim();
    if (!reason || reason.length < 10) { setMessage("Customer moderation requires a justification of at least 10 characters."); return; }
    setModerationBusy(`customer:${userId}`); setMessage(null);
    try { await moderateCustomer({ data: { userId, action, reason } }); window.location.reload(); }
    catch { setMessage("Customer moderation failed. Verify the account state and try again."); }
    finally { setModerationBusy(null); }
  }

  async function requestProviderRefund(orderId: string) {
    const note = refundNoteByOrderId[orderId]?.trim() ?? "";
    if (note.length < 12) { setMessage("Refund execution requires a justification of at least 12 characters."); return; }
    setRefundBusyId(orderId);
    setMessage(null);
    try {
      await requestAdminProviderRefund({ data: { orderId, note } });
      window.location.reload();
    } catch {
      setMessage("Provider refund request failed. Verify the payment and provider status.");
    } finally {
      setRefundBusyId(null);
    }
  }

  async function saveGlobalCommission() {
    const rate = Number(globalCommission);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) { setMessage("Commission must be between 0% and 100%."); return; }
    if (commissionReason.trim().length < 12) { setMessage("Commission changes require a documented reason (12+ characters)."); return; }
    setCommissionBusy(true); setMessage(null);
    try { await setGlobalCommissionRule({ data: { ratePercent: rate, active: true, reason: commissionReason.trim() } }); window.location.reload(); }
    catch { setMessage("Commission policy update failed."); }
    finally { setCommissionBusy(false); }
  }

  async function saveOverride() {
    const id = overrideId.trim(); const rate = Number(overrideRate);
    if (!id) { setMessage("An override ID is required."); return; }
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) { setMessage("Commission must be between 0% and 100%."); return; }
    if (commissionReason.trim().length < 12) { setMessage("Commission changes require a documented reason (12+ characters)."); return; }
    setCommissionBusy(true); setMessage(null);
    try { await setCommissionRule({ data: { scopeType: overrideType, scopeId: id, ratePercent: rate, active: true, reason: commissionReason.trim() } }); window.location.reload(); }
    catch { setMessage("Commission override update failed."); }
    finally { setCommissionBusy(false); }
  }

  async function removeOverride(scopeType: "category" | "merchant" | "product", scopeId: string) {
    if (commissionReason.trim().length < 12) { setMessage("Commission changes require a documented reason (12+ characters)."); return; }
    setCommissionBusy(true); setMessage(null);
    try { await removeCommissionOverride({ data: { scopeType, scopeId, reason: commissionReason.trim() } }); window.location.reload(); }
    catch { setMessage("Commission override removal failed."); }
    finally { setCommissionBusy(false); }
  }

  async function revealSensitive(applicationId: string) {
    setBusyId(applicationId);
    setMessage(null);
    try {
      const result = await viewMerchantSensitiveData({ data: { applicationId } });
      setSensitiveById((current) => ({ ...current, [applicationId]: result }));
    } catch {
      setMessage("Sensitive merchant information could not be revealed.");
    } finally {
      setBusyId(null);
    }
  }

  async function review(applicationId: string, action: "start_review" | "approve" | "reject") {
    const reason = reasonById[applicationId]?.trim() || undefined;
    if (action !== "start_review" && (!reason || reason.length < 12)) {
      setMessage("An approval or rejection requires a documented reason of at least 12 characters.");
      return;
    }
    const locationInput = manualLocationById[applicationId];
    const manualLocation = action === "approve" && locationInput?.enabled ? {
      latitude: Number(locationInput.latitude), longitude: Number(locationInput.longitude),
      city: locationInput.city.trim(), neighborhood: locationInput.neighborhood.trim(),
      justification: locationInput.justification.trim(),
    } : undefined;
    if (manualLocation && (
      !locationInput.latitude.trim() || !locationInput.longitude.trim() ||
      !Number.isFinite(manualLocation.latitude) || !Number.isFinite(manualLocation.longitude) ||
      manualLocation.city.length < 2 || manualLocation.neighborhood.length < 2 ||
      manualLocation.justification.length < 15
    )) { setMessage("Manual location requires verified coordinates, city, neighborhood and a justification of at least 15 characters."); return; }
    setBusyId(applicationId);
    setMessage(null);
    try {
      await reviewMerchantApplication({ data: { applicationId, action, reason, manualLocation } });
      window.location.reload();
    } catch {
      setMessage("Merchant review failed. Refresh the dashboard and try again.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">ELEMARKET · Private workspace</p><h1 className="section-title">Operations overview</h1>
          <p className="mt-2 text-sm text-market-muted">Oversee merchant applications, customers, finance, enterprise, providers, campaigns and incident activity. Each protected operation is authorized by its server API.</p>
        </div>
        {message ? <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{message}</p> : null}
      </div>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metricLabels.map(([key, label]) => (
          <div key={String(key)} className="rounded-2xl border border-market-line bg-white p-5 shadow-market">
            <p className="text-xs font-bold text-market-muted">{label}</p>
            <p className="mt-2 text-2xl font-black">{data.metrics[key]}</p>
          </div>
        ))}
      </section>

      <AdminWorkspaceNav staffRole="owner" /><div className="mt-10"><AdminSupportWorkspace compact /></div>

      <section id="merchant-reviews" className="mt-10 rounded-2xl border border-market-line bg-white p-6 shadow-market">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black">Merchant verification queue</h2>
            <p className="mt-1 text-sm text-market-muted">Review applications without bypassing verification or ownership rules.</p>
          </div>
          <span className="rounded-full bg-black px-3 py-1 text-xs font-bold text-white">{data.merchantReviews.length} queued</span>
        </div>

        <div className="mt-6 space-y-4">
          {data.merchantReviews.length === 0 ? (
            <p className="rounded-xl border border-market-line p-5 text-sm text-market-muted">No pending merchant applications.</p>
          ) : data.merchantReviews.map((application: AdminDashboardData["merchantReviews"][number]) => {
            const busy = busyId === application.id;
            return (
              <article key={application.id} className="rounded-2xl border border-market-line p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-black">{application.businessName}</h3>
                    <p className="text-sm text-market-muted">{application.categories.join(" · ")} · {application.contact} · submitted {application.createdAt} UTC</p>
                    <p className="mt-1 text-xs text-market-muted">Application: {application.id}</p>
                  </div>
                  <span className="rounded-full border border-market-line px-3 py-1 text-xs font-bold">{application.status}</span>
                </div>

                <div className="mt-4 rounded-xl border border-market-line bg-market-soft p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-black">Business & tax information</p>
                      <p className="mt-1 text-xs text-market-muted">Business number and masked taxpayer information are visible in the queue. Full sensitive data requires an explicit audited reveal.</p>
                    </div>
                    <button disabled={busy} onClick={() => void revealSensitive(application.id)} className="rounded-xl bg-black px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{sensitiveById[application.id] ? "Sensitive data revealed" : "View sensitive information"}</button>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                    <div><span className="font-bold">Business no.</span> {application.businessNumber}</div>
                    <div><span className="font-bold">Taxpayer ID</span> {application.taxpayerIdMasked ?? "Not provided"}</div>
                    <div><span className="font-bold">Tax status</span> {application.taxRegistrationStatus ?? "Not provided"}</div>
                    <div><span className="font-bold">VAT</span> {application.vatRegistrationStatus ?? "Not provided"}</div>
                  </div>
                  {sensitiveById[application.id] ? (
                    <div className="mt-4 rounded-xl border border-market-line bg-white p-4 text-xs">
                      <p><span className="font-bold">Full taxpayer ID:</span> {sensitiveById[application.id].taxpayerId}</p>
                      <p className="mt-1"><span className="font-bold">Business type:</span> {sensitiveById[application.id].businessType}</p>
                    </div>
                  ) : null}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <VerificationBadge label="Email" status={application.verification.email} />
                  <VerificationBadge label="Phone" status={application.verification.phone} />
                  <VerificationBadge label="Identity" status={application.verification.identity} />
                  <VerificationBadge label="Business" status={application.verification.business} />
                  <VerificationBadge label="Document" status={application.verification.document} />
                  <VerificationBadge label="Payout" status={application.verification.payout} />
                </div>

                {application.status === "reviewing" && <section className="mt-4 rounded-xl border border-market-line bg-market-soft p-4" aria-label="Merchant location verification">
                  <label className="flex items-center gap-2 text-xs font-bold text-market-ink"><input type="checkbox" checked={manualLocationById[application.id]?.enabled ?? false} onChange={e => setLocationField(application.id, "enabled", e.target.checked)} /> Use independently verified business coordinates instead of automatic geocoding</label>
                  {manualLocationById[application.id]?.enabled && <div className="mt-3 space-y-3">
                    <p className="text-xs text-market-muted">Only use coordinates confirmed against the merchant's Ghana business address. Incorrect locations distort store discovery and delivery availability. This override is audited.</p>
                    <div className="grid gap-3 sm:grid-cols-2">{(["latitude", "longitude", "city", "neighborhood"] as const).map(field => <label key={field} className="text-xs font-bold capitalize">{field}<input required type={field === "latitude" || field === "longitude" ? "number" : "text"} step={field === "latitude" || field === "longitude" ? "any" : undefined} value={manualLocationById[application.id]?.[field] ?? ""} onChange={e => setLocationField(application.id, field, e.target.value)} className="mt-1 w-full rounded-lg border border-market-line bg-white px-3 py-2 text-sm" /></label>)}</div>
                    <label className="block text-xs font-bold">Verification source and reason<input required minLength={15} maxLength={1000} placeholder="Verified using merchant-supplied map pin, confirmed by support…" value={manualLocationById[application.id]?.justification ?? ""} onChange={e => setLocationField(application.id, "justification", e.target.value)} className="mt-1 w-full rounded-lg border border-market-line bg-white px-3 py-2 text-sm" /></label>
                  </div>}
                </section>}
                <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
                  <label className="flex-1 text-xs font-bold text-market-muted">
                    Decision reason (required for approval or rejection, 12+ characters)
                    <input
                      value={reasonById[application.id] ?? ""}
                      onChange={(event) => setReasonById((current) => ({ ...current, [application.id]: event.target.value }))}
                      maxLength={1000}
                      className="mt-1 w-full rounded-xl border border-market-line px-3 py-2 text-sm font-normal outline-none focus:ring-2"
                      placeholder="Explain what needs correction"
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {application.status === "pending" ? (
                      <button disabled={busy} onClick={() => void review(application.id, "start_review")} className="rounded-xl bg-black px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Start review</button>
                    ) : null}
                    {application.status === "reviewing" ? (
                      <>
                        <button disabled={busy} onClick={() => void review(application.id, "approve")} className="rounded-xl bg-market-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Approve</button>
                        <button disabled={busy} onClick={() => void review(application.id, "reject")} className="rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Reject</button>
                      </>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mt-10 rounded-2xl border border-market-line bg-white p-6 shadow-market">
        <h2 className="text-xl font-black">Product moderation queue</h2>
        <p className="mt-1 text-sm text-market-muted">New merchant listings remain private until an administrator approves them.</p>
        <div className="mt-5 space-y-3">
          {data.moderation.products.length === 0 ? <p className="text-sm text-market-muted">No products awaiting review.</p> : data.moderation.products.map((product: AdminModerationData["products"][number]) => (
            <article key={product.id} className="rounded-xl border border-market-line p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><p className="font-black">{product.name}</p><p className="text-xs text-market-muted">{product.merchantName} · GHS {product.price} · {product.createdAt}</p></div>
                <span className="rounded-full border border-market-line px-2 py-1 text-[11px] font-bold">{product.status}</span>
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input value={moderationReason[`product:${product.id}`] ?? ""} onChange={(e) => setModerationReason((c) => ({ ...c, [`product:${product.id}`]: e.target.value }))} maxLength={2000} placeholder="Reason / review note" className="flex-1 rounded-xl border border-market-line px-3 py-2 text-sm" />
                <button disabled={moderationBusy === `product:${product.id}`} onClick={() => void moderateProductListing(product.id, "approve")} className="rounded-xl bg-market-green px-3 py-2 text-xs font-bold text-white">Approve</button>
                <button disabled={moderationBusy === `product:${product.id}`} onClick={() => void moderateProductListing(product.id, "suspend")} className="rounded-xl bg-red-600 px-3 py-2 text-xs font-bold text-white">Suspend</button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section id="payment-exceptions" className="rounded-2xl border border-market-line bg-white p-6 shadow-market">
          <h2 className="text-xl font-black">Payment exceptions</h2>
          <div className="mt-4 space-y-3">
            {data.paymentExceptions.length === 0 ? <p className="text-sm text-market-muted">No payment exceptions.</p> : data.paymentExceptions.map((item: AdminDashboardData["paymentExceptions"][number]) => (
              <div key={item.id} className="rounded-xl border border-market-line p-4">
                <div className="flex justify-between gap-3 text-sm font-bold"><span>{item.status} · {item.providerKey}</span><span>GHS {item.amount}</span></div>
                <p className="mt-1 text-xs text-market-muted">{item.createdAt} UTC · {item.failureCode ?? "no failure code"}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-market-line bg-white p-6 shadow-market">
          <h2 className="text-xl font-black">Provider refund operations</h2>
          <p className="mt-1 text-xs text-market-muted">Payment providers control collection, settlement and refunds. ELEMARKET only records and requests provider actions.</p>
          <div className="mt-4 space-y-3">
            {data.refundRequests.length === 0 ? <p className="text-sm text-market-muted">No active provider refund operations.</p> : data.refundRequests.map((item: AdminDashboardData["refundRequests"][number]) => (
              <div key={item.id} className="rounded-xl border border-market-line p-4">
                <div className="flex justify-between gap-3 text-sm font-bold"><span>{item.status.replaceAll("_", " ")}</span><span>GHS {item.amount}</span></div>
                <p className="mt-1 text-xs text-market-muted">Order {item.orderId} · {item.createdAt} UTC · {item.providerRefundId ?? "provider refund not yet assigned"}</p>
                <p className="mt-2 text-sm">{item.reason ?? "Provider refund request"}</p>
                {item.status === "needs_attention" || item.status === "failed" ? <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <label className="flex-1 text-xs font-bold text-market-muted">Operator note
                    <input value={refundNoteByOrderId[item.orderId] ?? ""} onChange={(event) => setRefundNoteByOrderId((current) => ({ ...current, [item.orderId]: event.target.value }))} maxLength={2000} className="mt-1 w-full rounded-xl border border-market-line px-3 py-2 text-sm font-normal outline-none" placeholder="Record the provider-refund action" />
                  </label>
                  <button disabled={refundBusyId === item.orderId} onClick={() => void requestProviderRefund(item.orderId)} className="rounded-xl bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Retry provider refund</button>
                </div> : null}
              </div>
            ))}
          </div>
        </section>


        <section className="rounded-2xl border border-market-line bg-white p-6 shadow-market">
          <h2 className="text-xl font-black">Audit trail</h2>
          <div className="mt-4 max-h-96 space-y-2 overflow-auto [overflow-wrap:anywhere]">
            {data.auditEvents.length === 0 ? <p className="text-sm text-market-muted">No audit events recorded.</p> : data.auditEvents.map((event: AdminDashboardData["auditEvents"][number]) => (
              <div key={event.id} className="rounded-xl border border-market-line p-3 text-xs">
                <div className="flex flex-wrap justify-between gap-2 font-bold"><span>{event.eventType}</span><span>{event.outcome}</span></div>
                <p className="mt-1 text-market-muted">{event.resourceType}{event.resourceId ? `:${event.resourceId}` : ""} · {event.actorRole ?? "system"} · {event.createdAt} UTC</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section id="catalog-controls" className="mt-10 rounded-2xl border border-market-line bg-white p-6 shadow-market">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h2 className="text-xl font-black">Catalogue availability</h2><p className="mt-1 text-sm text-market-muted">Turn categories or individual subcategories on/off without deleting listings or historical orders. Disabled catalogue entries cannot receive new listings and are hidden from customer discovery.</p></div>
          <span className="rounded-full bg-market-soft px-3 py-1 text-xs font-black">Admin controlled · audited</span>
        </div>
        <div className="mt-5 space-y-4">
          {data.catalogTaxonomy.map((category)=><div key={category.key} className="rounded-xl border border-market-line p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-black">{category.name}</p><p className="text-xs text-market-muted">{category.key} · {category.activeProducts} active product{category.activeProducts===1?"":"s"}</p></div><span className={`rounded-full px-2 py-1 text-xs font-bold ${category.active?"bg-green-50 text-green-700":"bg-red-50 text-red-700"}`}>{category.active?"Enabled":"Disabled"}</span></div>
            <div className="mt-3 flex flex-wrap gap-2"><input value={taxonomyReason[category.key]??""} onChange={e=>setTaxonomyReason(v=>({...v,[category.key]:e.target.value}))} maxLength={2000} placeholder="Reason for category change" className="min-w-[240px] flex-1 rounded-xl border border-market-line px-3 py-2 text-sm"/><button disabled={taxonomyBusy===category.key} onClick={()=>void setTaxonomyState("category",category.key,null,!category.active)} className={`rounded-xl px-3 py-2 text-xs font-black text-white disabled:opacity-50 ${category.active?"bg-red-600":"bg-market-green"}`}>{category.active?"Disable category":"Enable category"}</button></div>
            {category.subcategories.length?<div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{category.subcategories.map(sub=>{const id=`${category.key}:${sub.key}`;return <div key={sub.key} className="rounded-lg border border-market-line p-3"><div className="flex items-center justify-between gap-2"><div><p className="text-sm font-bold">{sub.name}</p><p className="text-[11px] text-market-muted">{sub.activeProducts} active products</p></div><span className={`text-[11px] font-bold ${sub.active&&category.active?"text-green-700":"text-red-700"}`}>{sub.active?"On":"Off"}{!category.active?" · parent off":""}</span></div><input value={taxonomyReason[id]??""} onChange={e=>setTaxonomyReason(v=>({...v,[id]:e.target.value}))} maxLength={2000} placeholder="Reason" className="mt-2 w-full rounded-lg border border-market-line px-2 py-1.5 text-xs"/><button disabled={taxonomyBusy===id} onClick={()=>void setTaxonomyState("subcategory",category.key,sub.key,!sub.active)} className={`mt-2 w-full rounded-lg px-2 py-1.5 text-xs font-black text-white disabled:opacity-50 ${sub.active?"bg-red-600":"bg-market-green"}`}>{sub.active?"Disable":"Enable"}</button></div>})}</div>:null}
          </div>)}
        </div>
      </section>

      <section id="commission-policy" className="mt-10 rounded-2xl border border-market-line bg-white p-6 shadow-market">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="mb-4"><label className="block text-sm font-bold" htmlFor="commission-decision-reason">Required change reason</label><textarea id="commission-decision-reason" value={commissionReason} onChange={e=>setCommissionReason(e.target.value)} maxLength={1000} minLength={12} rows={2} placeholder="State business reason and approval evidence for this policy change" className="mt-2 w-full rounded-xl border border-market-line p-3 text-sm" /></div><div><h2 className="text-xl font-black">Commission policy</h2><p className="mt-1 text-sm text-market-muted">ELEMARKET earns from commission only. Delivery is customer-paid. Provider settlement fees are outside the ELEMARKET marketplace ledger.</p></div>
          <span className="rounded-full bg-market-soft px-3 py-1 text-xs font-black">ELEMARKET marketplace settlement fee: GHS 0.00</span>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-market-line p-4">
            <p className="text-xs font-bold text-market-muted">Global commission</p>
            <div className="mt-2 flex gap-2"><input inputMode="decimal" value={globalCommission || (data.commission.rules.find((r: AdminCommissionData["rules"][number]) => r.scopeType === "global")?.ratePercent ?? "5.00")} onChange={e=>setGlobalCommission(e.target.value)} className="w-full rounded-xl border border-market-line px-3 py-2 text-sm" /><button disabled={commissionBusy} onClick={()=>void saveGlobalCommission()} className="rounded-xl bg-black px-4 py-2 text-xs font-black text-white disabled:opacity-50">Save</button></div>
          </div>
          <div className="rounded-xl border border-market-line p-4 lg:col-span-2">
            <p className="text-xs font-bold text-market-muted">Add / update override</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-[150px_1fr_120px_auto]">
              <select value={overrideType} onChange={e=>setOverrideType(e.target.value as typeof overrideType)} className="rounded-xl border border-market-line px-3 py-2 text-sm"><option value="category">Category</option><option value="merchant">Merchant</option><option value="product">Product</option></select>
              <input value={overrideId} onChange={e=>setOverrideId(e.target.value)} placeholder="Category / merchant ID / product ID" className="rounded-xl border border-market-line px-3 py-2 text-sm" />
              <input inputMode="decimal" value={overrideRate} onChange={e=>setOverrideRate(e.target.value)} placeholder="Rate %" className="rounded-xl border border-market-line px-3 py-2 text-sm" />
              <button disabled={commissionBusy} onClick={()=>void saveOverride()} className="rounded-xl bg-market-green px-4 py-2 text-xs font-black text-white disabled:opacity-50">Save override</button>
            </div>
          </div>
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="border-b border-market-line text-xs text-market-muted"><th className="px-2 py-3">Scope</th><th className="px-2 py-3">Rate</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Action</th></tr></thead><tbody>{data.commission.rules.map((rule: AdminCommissionData["rules"][number])=><tr key={rule.id} className="border-b border-market-line last:border-0"><td className="px-2 py-3 font-semibold">{rule.scopeType}{rule.scopeId ? ` · ${rule.scopeId}` : ""}</td><td className="px-2 py-3">{rule.ratePercent}%</td><td className="px-2 py-3">{rule.active ? "Active" : "Inactive"}</td><td className="px-2 py-3">{rule.scopeType !== "global" ? <button disabled={commissionBusy} onClick={()=>void removeOverride(rule.scopeType as "category" | "merchant" | "product", rule.scopeId!)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-bold text-red-700">Remove override</button> : <span className="text-xs text-market-muted">Fallback policy</span>}</td></tr>)}</tbody></table>
        </div>
        <p className="mt-4 text-xs text-market-muted">Historical orders keep the commission rate and amount captured at checkout. Changing the policy affects new orders only.</p>
      </section>

      <section className="mt-10 grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-market-line bg-white p-6 shadow-market">
          <div><h2 className="text-xl font-black">Merchant controls</h2><p className="mt-1 text-sm text-market-muted">Suspend or reinstate merchants without deleting financial or audit history.</p></div>
          <div className="mt-5 space-y-3">
            {data.moderation.merchants.length === 0 ? <p className="text-sm text-market-muted">No merchants found.</p> : data.moderation.merchants.map((merchant: AdminModerationData["merchants"][number]) => (
              <div key={merchant.id} className="rounded-xl border border-market-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-black">{merchant.name}</p><p className="text-xs text-market-muted">{merchant.ownerEmail ?? "No owner email"} · {merchant.id}</p></div><span className="rounded-full border px-2 py-1 text-xs font-bold">{merchant.status}</span></div>
                <p className="mt-2 text-xs text-market-muted">Tier: {merchant.tier} · Settlement: {merchant.settlementModel} · Catalog: {merchant.catalogSource}</p>
                <input value={moderationReason[`merchant:${merchant.id}`] ?? ""} onChange={e=>setModerationReason(v=>({...v,[`merchant:${merchant.id}`]:e.target.value}))} maxLength={2000} placeholder="Reason (optional)" className="mt-3 w-full rounded-xl border border-market-line px-3 py-2 text-sm" />
                <input value={moderationReason[`merchant-enterprise:${merchant.id}`] ?? ""} onChange={e=>setModerationReason(v=>({...v,[`merchant-enterprise:${merchant.id}`]:e.target.value}))} maxLength={2000} placeholder="Enterprise-mode reason (required)" className="mt-2 w-full rounded-xl border border-market-line px-3 py-2 text-sm" />
                <div className="mt-3 flex flex-wrap gap-2">{merchant.status === "suspended" ? <button disabled={moderationBusy===`merchant:${merchant.id}`} onClick={()=>void moderateMerchantAccount(merchant.id,"reinstate")} className="rounded-xl bg-market-green px-3 py-2 text-xs font-bold text-white">Reinstate</button> : <button disabled={moderationBusy===`merchant:${merchant.id}`} onClick={()=>void moderateMerchantAccount(merchant.id,"suspend")} className="rounded-xl bg-red-600 px-3 py-2 text-xs font-bold text-white">Suspend merchant</button>} {merchant.settlementModel === "enterprise_direct" ? <button disabled={moderationBusy===`merchant-enterprise:${merchant.id}`} onClick={()=>void setEnterpriseMode(merchant.id,false)} className="rounded-xl border border-market-line px-3 py-2 text-xs font-bold">Disable enterprise mode</button> : <button disabled={moderationBusy===`merchant-enterprise:${merchant.id}`} onClick={()=>void setEnterpriseMode(merchant.id,true)} className="rounded-xl bg-black px-3 py-2 text-xs font-bold text-white">Enable enterprise API mode</button>}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-market-line bg-white p-6 shadow-market">
          <div><h2 className="text-xl font-black">Customer controls</h2><p className="mt-1 text-sm text-market-muted">Blacklist abusive or fraudulent customer accounts and reinstate them when resolved.</p></div>
          <div className="mt-5 space-y-3">
            {data.moderation.customers.length === 0 ? <p className="text-sm text-market-muted">No customers found.</p> : data.moderation.customers.map((customer: AdminModerationData["customers"][number]) => (
              <div key={customer.id} className="rounded-xl border border-market-line p-4">
                <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-black">{customer.name}</p><p className="text-xs text-market-muted">{customer.email} · {customer.id}</p></div><span className="rounded-full border px-2 py-1 text-xs font-bold">{customer.status}</span></div>
                <input value={moderationReason[`customer:${customer.id}`] ?? ""} onChange={e=>setModerationReason(v=>({...v,[`customer:${customer.id}`]:e.target.value}))} maxLength={2000} placeholder="Reason (required)" className="mt-3 w-full rounded-xl border border-market-line px-3 py-2 text-sm" />
                <div className="mt-3 flex flex-wrap gap-2">{customer.status === "blacklisted" ? <button disabled={moderationBusy===`customer:${customer.id}`} onClick={()=>void moderateCustomerAccount(customer.id,"unblacklist")} className="rounded-xl bg-market-green px-3 py-2 text-xs font-bold text-white">Reinstate customer</button> : <button disabled={moderationBusy===`customer:${customer.id}`} onClick={()=>void moderateCustomerAccount(customer.id,"blacklist")} className="rounded-xl bg-red-600 px-3 py-2 text-xs font-bold text-white">Blacklist customer</button>}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
