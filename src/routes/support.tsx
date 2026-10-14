import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Headphones, Send } from "lucide-react";
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
  const { conversation, body, setBody, busy, loading, error, send, retry } = useCustomerSupportChat(userId, orderId, true);
  const draft = conversation?.draft;
  const draftObject = draft && typeof draft === "object" && !Array.isArray(draft) ? draft : null;
  const draftId = typeof draftObject?.draftId === "string" ? draftObject.draftId : null;
  const draftItems = Array.isArray(draftObject?.items) ? draftObject.items : [];
  const closed = conversation?.status === "closed";

  return (
    <main className="min-h-screen bg-market-bg px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-2xl">
        <Link to="/" className="inline-flex items-center gap-2 text-sm font-bold text-market-muted hover:text-market-green"><ArrowLeft size={16} /> Marketplace</Link>
        <section className="mt-5 overflow-hidden rounded-3xl border border-market-line bg-white shadow-market">
          <header className="flex items-center gap-3 border-b border-market-line px-5 py-4">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-market-soft text-market-green"><Headphones size={18} /></span>
            <div><h1 className="text-lg font-black">ELEMARKET Support</h1><p className="text-xs text-market-muted">{closed ? "This conversation is closed." : "Chat directly with the ELEMARKET support team."}</p></div>
          </header>
          <div className="min-h-[420px] space-y-3 p-5" role="log" aria-label="Support messages" aria-live="polite">
            {loading && <p role="status" className="text-sm text-market-muted">Opening secure support…</p>}
            {draftId && <div className="rounded-2xl border border-market-green/20 bg-market-soft p-4">
              <p className="text-sm font-black">Order prepared by ELEMARKET Support</p>
              <p className="mt-1 text-xs text-market-muted">Review the live price, stock and delivery details before payment.</p>
              <div className="mt-3 space-y-2">{draftItems.map((item, index) => {
                if (!item || typeof item !== "object" || Array.isArray(item)) return null;
                return <p key={index} className="text-xs">{typeof item.name === "string" ? item.name : "Product"} × {typeof item.quantity === "number" ? item.quantity : 1}</p>;
              })}</div>
              <a href={`/checkout?draftId=${encodeURIComponent(draftId)}`} className="mt-4 inline-flex w-full justify-center rounded-xl bg-market-orange px-4 py-3 text-xs font-black text-white">Review & continue to payment</a>
              <p className="mt-2 text-[10px] leading-4 text-market-muted">The agent cannot pay on your behalf. Prices, stock and delivery are checked again at checkout.</p>
            </div>}
            {!loading && conversation?.messages.length === 0 && !draftId && <p className="rounded-2xl bg-market-soft p-4 text-sm text-market-muted">Tell us what you need help with. For order issues, use Order Support from your cart or order page.</p>}
            {conversation?.messages.map(message => <div key={message.id} className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm [overflow-wrap:anywhere] ${message.senderType === "customer" ? "ml-auto bg-market-green text-white" : "bg-market-soft text-market-ink"}`}>{message.body}</div>)}
            {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{error}{!loading && !conversation && <button type="button" onClick={retry} className="ml-2 underline">Retry</button>}</p>}
          </div>
          <div className="border-t border-market-line p-3">
            <div className="flex items-end gap-2">
              <textarea value={body} onChange={event => setBody(event.target.value.slice(0, 4000))} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} rows={2} maxLength={4000} disabled={busy || !conversation || closed} placeholder={closed ? "This conversation is closed" : "Write a message…"} className="min-h-12 flex-1 resize-none rounded-xl border border-market-line px-3 py-2.5 text-sm outline-none focus:border-market-green disabled:bg-market-soft" aria-label="Support message" />
              <button type="button" onClick={() => void send()} disabled={busy || !body.trim() || !conversation || closed} className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-market-orange text-white disabled:opacity-40" aria-label="Send support message"><Send size={17} /></button>
            </div>
            <p className="mt-2 text-[10px] text-market-muted">ELEMARKET Support only. We never expose direct merchant contact through this chat.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
