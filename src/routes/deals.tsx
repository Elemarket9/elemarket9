import { createFileRoute, Link } from "@tanstack/react-router";
import { listPublicMarketplaceDeals } from "@/modules/administration/public/transport/public/deals.functions";

export const Route = createFileRoute("/deals")({
  head: () => ({ meta: [{ title: "Deals | ELEMARKET" }, { name: "description", content: "Current ELEMARKET promo codes you can use at checkout." }] }),
  loader: async () => ({ deals: await listPublicMarketplaceDeals() }),
  component: Deals,
});

type Deal = {
  code: string; name: string; description: string | null; discount_type: string; discount_value: string;
  max_discount: string | null; min_subtotal: string; ends_at: string | Date; first_order_only: boolean; categories: string[];
};

const ghs = (v: string | number) => `GH₵ ${Number(v).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Deals() {
  const { deals } = Route.useLoaderData() as { deals: Deal[] };
  return (
    <main className="min-h-screen bg-market-bg px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <Link to="/" className="font-black text-market-green">ELEMARKET</Link>
        <h1 className="mt-5 text-3xl font-black">Deals</h1>
        <p className="mt-2 text-sm text-market-muted">
          Enter a code at checkout. One code per order. ELEMARKET pays for these discounts, so merchants are paid in full.
          Codes end early if the promotion's budget runs out.
        </p>
        {deals.length ? (
          <ul className="mt-6 grid gap-3">
            {deals.map((d) => (
              <li key={d.code} className="rounded-2xl border border-market-line bg-white p-5 shadow-market">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-black">{d.name}</h2>
                    {d.description ? <p className="mt-1 text-sm text-market-muted">{d.description}</p> : null}
                  </div>
                  <span className="rounded-xl bg-market-soft px-3 py-2 font-mono text-sm font-black">{d.code}</span>
                </div>
                <p className="mt-3 text-sm font-bold text-market-green">
                  {d.discount_type === "percentage" ? `${Number(d.discount_value)}% off` : `${ghs(d.discount_value)} off`}
                  {d.max_discount ? `, up to ${ghs(d.max_discount)}` : ""}
                </p>
                <p className="mt-1 text-xs text-market-muted">
                  {Number(d.min_subtotal) > 0 ? `Minimum basket ${ghs(d.min_subtotal)} · ` : ""}
                  {d.first_order_only ? "First order only · " : ""}
                  {d.categories.length ? `${d.categories.join(", ")} · ` : ""}
                  Ends {new Date(d.ends_at).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" })}.
                  The discount may be smaller on low-value orders.
                </p>
              </li>
            ))}
          </ul>
        ) : <p className="mt-6 rounded-2xl border border-market-line bg-white p-5 text-sm text-market-muted">No deals right now. Check back soon.</p>}
      </div>
    </main>
  );
}
