import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Headphones } from "lucide-react";
import { SupportComposer, SupportMessages } from "@/components/support-thread";
import { supportStatusLabel } from "@/modules/support/public/support-labels";
import { RedirectToSignIn, SignInGate } from "@/modules/identity/public/auth/gates";
import { useCurrentUserState } from "@/modules/identity/public/auth/use-current-user";
import { useCustomerSupportChat } from "@/modules/support/public/use-customer-support-chat";
import { z } from "zod";

const searchSchema = z.object({ orderId: z.string().trim().min(1).max(64).optional() });
export const Route = createFileRoute("/support")({ validateSearch: searchSchema, component: SupportPage });

function SupportPage() {
  const { user } = useCurrentUserState();
  const { orderId } = Route.useSearch();
  return <SignInGate fallback={<RedirectToSignIn />}><SupportChat key={JSON.stringify([user?.id, orderId])} userId={user?.id ?? null} orderId={orderId ?? null} /></SignInGate>;
}

function SupportChat({ userId, orderId }: { userId: string | null; orderId: string | null }) {
  const chat = useCustomerSupportChat(userId, orderId, true);
  const { conversation, body, setBody, loading, send } = chat;
  const draft = conversation?.draft;
  const draftObject = draft && typeof draft === "object" && !Array.isArray(draft) ? draft : null;
  const draftId = typeof draftObject?.draftId === "string" ? draftObject.draftId : null;
  const draftItems = Array.isArray(draftObject?.items) ? draftObject.items : [];
  const closed = conversation?.status === "closed";

  return (
    <main className="min-h-screen bg-market-bg px-4 py-6 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-2xl">
        <Link to="/" className="inline-flex min-h-11 items-center gap-2 text-sm font-bold text-market-muted hover:text-market-green"><ArrowLeft size={16} aria-hidden="true" /> Marketplace</Link>
        <section className="mt-3 overflow-hidden rounded-3xl border border-market-line bg-white shadow-market">
          <header className="flex items-center gap-3 border-b border-market-line px-5 py-4">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-market-soft text-market-green"><Headphones size={20} aria-hidden="true" /></span>
            <div>
              <h1 className="text-lg font-black">ELEMARKET Support</h1>
              <p className="text-sm text-market-muted">{supportStatusLabel(conversation?.status)}{orderId ? ` · Order ${orderId.slice(-8)}` : ""}</p>
            </div>
          </header>
          <div className="min-h-[420px] bg-market-bg/60 p-4 sm:p-5">
            {draftId ? (
              <div className="mb-3 rounded-2xl border border-market-green/20 bg-white p-4">
                <p className="text-sm font-black">Order prepared by ELEMARKET Support</p>
                <p className="mt-1 text-sm text-market-muted">Review the live price, stock and delivery details before payment.</p>
                <div className="mt-3 space-y-2">{draftItems.map((item, index) => {
                  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
                  return <p key={index} className="text-sm">{typeof item.name === "string" ? item.name : "Product"} × {typeof item.quantity === "number" ? item.quantity : 1}</p>;
                })}</div>
                <a href={`/checkout?draftId=${encodeURIComponent(draftId)}`} className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-market-orange px-4 text-sm font-black text-white">Review and pay securely</a>
                <p className="mt-2 text-xs leading-5 text-market-muted">The agent cannot pay on your behalf. Prices, stock and delivery are checked again at checkout.</p>
              </div>
            ) : null}
            <SupportMessages
              conversation={conversation} outgoing={chat.outgoing} loading={loading} error={chat.error} stale={chat.stale} online={chat.online}
              emptyText="Tell us what you need help with. For order issues, open support from the order so the agent sees it straight away. Your message goes to the ELEMARKET support team and their reply appears here."
              onRetryOpen={chat.retry} onRetrySend={() => void chat.retrySend()} onDiscard={chat.discardFailed}
            />
          </div>
          <div className="border-t border-market-line p-3">
            <SupportComposer body={body} setBody={setBody} send={() => void send()} disabled={!conversation} closed={closed} waitingForSend={chat.outgoing !== null} />
            <p className="mt-2 text-xs text-market-muted">ELEMARKET Support only. We never expose direct merchant contact through this chat.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
