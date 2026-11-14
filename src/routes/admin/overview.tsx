import { createFileRoute, redirect } from "@tanstack/react-router";
import { AdminWorkspaceNav } from "@/components/admin-workspace-nav";
import { getAdminAccessState } from "@/modules/administration/public/transport/admin/access.functions";
import { loadAdminOverview } from "@/modules/administration/public/transport/admin/dashboard.functions";

export const Route = createFileRoute("/admin/overview")({
  head: () => ({ meta: [{ title: "Marketplace overview | ELEMARKET" }, { name: "robots", content: "noindex,nofollow,noarchive" }] }),
  loader: async () => {
    const access = await getAdminAccessState();
    if (!(access.staffRole === "owner" || access.capabilities.includes("admin.overview.view"))) throw redirect({ to: "/admin" });
    return { overview: await loadAdminOverview(), access };
  },
  component: Overview,
  errorComponent: () => (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl font-black">Admin access required</h1>
      <p className="mt-3 text-sm text-market-muted">Ask the Main Administrator for the marketplace overview permission.</p>
    </main>
  ),
});

// Grouped the way a store-operations lead reads them: what needs people now, then health.
const GROUPS: Array<{ title: string; items: Array<[string, string, string]> }> = [
  {
    title: "Needs attention",
    items: [
      ["overdueMerchantReviews", "Merchant reviews overdue", "Past the review time target."],
      ["openRiskFlags", "Open fraud/risk flags", "Waiting for a decision."],
      ["refundExceptions", "Refund exceptions", "Refunds or payment cases needing a person."],
      ["stalePaymentAttempts", "Stale payment attempts", "Started but not finished in time."],
    ],
  },
  {
    title: "Queues",
    items: [
      ["merchantReviews", "Merchant applications", "Pending or under review."],
      ["pendingProviderApplications", "Provider applications", "Payment, delivery and financing partners."],
      ["pendingPayments", "Payment attempts in progress", "Customers mid-checkout."],
    ],
  },
  {
    title: "Marketplace",
    items: [
      ["ordersToday", "Orders today", "Since midnight."],
      ["activeMerchants", "Active merchants", "Currently trading."],
      ["errors24h", "System errors (24h)", "Logged by the platform."],
      ["rejectedWebhooks24h", "Rejected provider callbacks (24h)", "Failed signature or validation."],
    ],
  },
];

function Overview() {
  const { overview, access } = Route.useLoaderData();
  const m = overview.metrics as Record<string, number>;
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <AdminWorkspaceNav staffRole={access.staffRole} capabilities={access.capabilities} />
      <section className="rounded-3xl border border-market-line bg-white p-6">
        <p className="text-xs font-black uppercase tracking-widest text-market-muted">Read-only</p>
        <h1 className="mt-2 text-3xl font-black">Marketplace overview</h1>
        <p className="mt-2 text-sm text-market-muted">
          Live counts only. Acting on any item needs the matching permission in its own workspace. Updated{" "}
          {new Date(overview.generatedAt).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" })}.
        </p>
      </section>
      {GROUPS.map((group) => (
        <section key={group.title} className="mt-6" aria-label={group.title}>
          <h2 className="text-lg font-black">{group.title}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {group.items.map(([key, label, hint]) => {
              const value = m[key] ?? 0;
              const alert = group.title === "Needs attention" && value > 0;
              return (
                <div key={key} className={`rounded-2xl border p-4 ${alert ? "border-market-orange bg-white" : "border-market-line bg-white"}`}>
                  <p className="text-xs font-black uppercase tracking-wide text-market-muted">{label}</p>
                  <p className={`mt-2 text-3xl font-black ${alert ? "text-market-orange" : ""}`}>{value.toLocaleString("en-GH")}</p>
                  <p className="mt-1 text-xs text-market-muted">{hint}</p>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}
