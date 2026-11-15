import { useEffect, useMemo, useRef, useState } from "react";
import { SupportComposer, SupportMessages } from "@/components/support-thread";
import { supportStatusLabel } from "@/modules/support/public/support-labels";
import { Headphones, Mail, MessageCircle, Phone, X } from "lucide-react";
import { useCurrentUserState } from "@/modules/identity/public/auth/use-current-user";
import { useCustomerSupportChat, useSupportUnread } from "@/modules/support/public/use-customer-support-chat";
import type { CurrentUserState } from "@/modules/identity/public/auth/use-current-user";

type SupportMode = "home" | "order";

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const SUPPORT_EMAIL = configured(import.meta.env.VITE_ELEMARKET_SUPPORT_EMAIL);
const SUPPORT_PHONE = configured(import.meta.env.VITE_ELEMARKET_SUPPORT_PHONE);
const SUPPORT_WHATSAPP_RAW = configured(import.meta.env.VITE_ELEMARKET_SUPPORT_WHATSAPP);
const SUPPORT_WHATSAPP = SUPPORT_WHATSAPP_RAW && /^(https:\/\/(?:wa\.me|api\.whatsapp\.com)\/)/i.test(SUPPORT_WHATSAPP_RAW)
  ? SUPPORT_WHATSAPP_RAW
  : null;

/**
 * In-context customer support. The widget never auto-opens and never navigates
 * the customer away from shopping for normal chat use. A full-page support
 * route remains available only as an accessibility/fallback surface.
 */
export function ContactSupportWidget({ mode = "home", orderId = null }: { mode?: SupportMode; orderId?: string | null }) {
  const identity = useCurrentUserState();
  return <SupportWidget key={JSON.stringify([identity.user?.id ?? null, orderId])} mode={mode} orderId={orderId} identity={identity} />;
}

function SupportWidget({ mode, orderId, identity }: { mode: SupportMode; orderId: string | null; identity: CurrentUserState }) {
  const [open, setOpen] = useState(false);
  const [sessionStalled, setSessionStalled] = useState(false);
  const { user, isPending } = identity;
  const chat = useCustomerSupportChat(user?.id ?? null, orderId, open && !isPending);
  const { conversation, body, setBody, loading, send } = chat;
  // Replies that arrive while the chat is closed show as a badge on the button.
  const unread = useSupportUnread(user?.id ?? null, !open && !isPending);
  const openButton = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) closeButton.current?.focus();
    else if (wasOpen.current) openButton.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    setSessionStalled(false);
    if (!open || !isPending) return;
    const timer = window.setTimeout(() => setSessionStalled(true), 25_000);
    return () => window.clearTimeout(timer);
  }, [open, isPending]);

  const contactItems = useMemo(() => [
    SUPPORT_EMAIL ? { label: "Email", href: `mailto:${SUPPORT_EMAIL}`, icon: Mail } : null,
    SUPPORT_PHONE ? { label: "Call", href: `tel:${SUPPORT_PHONE}`, icon: Phone } : null,
    SUPPORT_WHATSAPP ? { label: "WhatsApp", href: SUPPORT_WHATSAPP, icon: MessageCircle } : null,
  ].filter(Boolean) as Array<{ label: string; href: string; icon: typeof Mail }>, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    const onOpenSupport = () => setOpen(true);
    window.addEventListener("elemarket:open-support", onOpenSupport);
    return () => window.removeEventListener("elemarket:open-support", onOpenSupport);
  }, []);

  return (
    <div className="fixed bottom-4 right-4 z-[60] sm:bottom-5 sm:right-5" data-support-widget>
      {open ? (
        <section
          className="fixed inset-0 flex flex-col overflow-hidden bg-white sm:static sm:h-[min(38rem,calc(100dvh-6rem))] sm:w-[24rem] sm:rounded-2xl sm:border sm:border-market-line sm:shadow-market-lg"
          role="dialog"
          aria-label="ELEMARKET customer support"
        >
          <header className="flex items-center justify-between border-b border-market-line px-3.5 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-market-soft text-market-green">
                <Headphones size={16} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-black">ELEMARKET Support</p>
                <p className="truncate text-xs text-market-muted">{supportStatusLabel(conversation?.status)}</p>
              </div>
            </div>
            <button ref={closeButton} type="button" onClick={() => setOpen(false)} className="grid h-11 w-11 place-items-center rounded-lg text-market-muted hover:bg-market-soft" aria-label="Close support chat">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto bg-market-bg/60 p-3">
            {isPending ? <p role="status" className="rounded-xl bg-white p-3 text-sm text-market-muted">Opening secure support…</p> : null}
            {sessionStalled && isPending ? (
              <div role="alert" className="mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                Your sign-in session is taking too long to load. Check your connection and try reloading the page.
                <button type="button" onClick={() => window.location.reload()} className="mt-2 block min-h-11 rounded-lg border border-amber-300 bg-white px-4 font-black">Reload</button>
              </div>
            ) : null}
            {!isPending && !user ? (
              <div className="rounded-2xl border border-market-line bg-white p-4 text-sm">
                <p className="font-black">Sign in to chat securely</p>
                <p className="mt-1 text-sm leading-6 text-market-muted">Your support conversation is tied to your customer account so another shopper cannot read it.</p>
                <a href="/login" className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-market-green px-4 text-sm font-black text-white">Sign in or create account</a>
              </div>
            ) : null}
            {conversation?.draft ? (
              <div className="mb-3 rounded-2xl border border-market-green/20 bg-white p-3 text-sm">
                <p className="font-black">Support prepared an order draft</p>
                <p className="mt-1 text-market-muted">Review the live price, stock and delivery details before payment.</p>
                <a href={`/checkout?draftId=${encodeURIComponent(String((conversation.draft as { draftId?: string }).draftId ?? ""))}`} className="mt-2 inline-flex min-h-11 items-center rounded-lg bg-market-orange px-4 font-black text-white">Review draft</a>
              </div>
            ) : null}
            {user ? (
              <SupportMessages
                conversation={conversation} outgoing={chat.outgoing} loading={loading} error={chat.error} stale={chat.stale} online={chat.online}
                emptyText={mode === "order"
                  ? "Tell us what you need help with for your order or checkout. Your message goes straight to the ELEMARKET support team, and their reply appears here."
                  : "Tell us what you need help with. Your message goes straight to the ELEMARKET support team. You can keep shopping; a red dot on the chat button shows when we reply."}
                onRetryOpen={chat.retry} onRetrySend={() => void chat.retrySend()} onDiscard={chat.discardFailed}
              />
            ) : null}
          </div>

          {user ? (
            <div className="border-t border-market-line bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <SupportComposer body={body} setBody={setBody} send={() => void send()} disabled={!conversation} closed={conversation?.status === "closed"} waitingForSend={chat.outgoing !== null} />
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <a href={orderId ? `/support?orderId=${encodeURIComponent(orderId)}` : "/support"} className="py-1 text-xs font-bold text-market-green">Open full support view</a>
                {contactItems.map(({ label, href }) => <a key={label} href={href} className="py-1 text-xs font-semibold text-market-muted hover:text-market-green">{label}</a>)}
              </div>
            </div>
          ) : contactItems.length > 0 ? (
            <div className="flex flex-wrap gap-2 border-t border-market-line p-3">
              {contactItems.map(({ label, href, icon: Icon }) => (
                <a key={label} href={href} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-market-line px-3 text-xs font-bold text-market-ink">
                  <Icon size={13} className="text-market-green" aria-hidden="true" /> {label}
                </a>
              ))}
            </div>
          ) : null}
        </section>
      ) : (
        <button
          type="button"
          ref={openButton}
          onClick={() => setOpen(true)}
          className="relative inline-flex h-12 items-center gap-2 rounded-full border border-market-line bg-white px-4 text-sm font-black text-market-ink shadow-market hover:border-market-green/30 hover:bg-market-soft"
          aria-expanded={false}
          aria-label={`${mode === "order" ? "Open order support chat" : "Open ELEMARKET support chat"}${unread > 0 ? `, ${unread} new ${unread === 1 ? "reply" : "replies"}` : ""}`}
        >
          <MessageCircle size={18} className="text-market-green" aria-hidden="true" />
          {unread > 0 ? "New reply" : mode === "order" ? "Order Support" : "Chat Support"}
          {unread > 0 ? (
            <span aria-hidden="true" className="absolute -right-1 -top-1 grid h-6 min-w-6 place-items-center rounded-full bg-red-600 px-1.5 text-xs font-black text-white">{unread > 9 ? "9+" : unread}</span>
          ) : null}
        </button>
      )}
    </div>
  );
}
