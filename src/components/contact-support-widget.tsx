import { useEffect, useMemo, useRef, useState } from "react";
import { Headphones, Mail, MessageCircle, Phone, Send, X } from "lucide-react";
import { useCurrentUserState } from "@/modules/identity/public/auth/use-current-user";
import type { CustomerSupportState } from "@/modules/support/public/support.functions";
import { useCustomerSupportChat } from "@/modules/support/public/use-customer-support-chat";
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

function statusLabel(status: CustomerSupportState["status"] | undefined) {
  if (status === "waiting_support") return "Waiting for ELEMARKET";
  if (status === "waiting_customer") return "Waiting for you";
  if (status === "resolved") return "Resolved — reply to reopen";
  if (status === "closed") return "Closed";
  return "Support available";
}

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
  const { conversation, body, setBody, busy, loading, error, send, retry } = useCustomerSupportChat(user?.id ?? null, orderId, open && !isPending);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (open) messagesEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [conversation?.messages.length, open]);

  return (
    <div className="fixed bottom-4 right-4 z-[60] sm:bottom-5 sm:right-5" data-support-widget>
      {open ? (
        <section
          className="flex h-[min(38rem,calc(100dvh-6rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-market-line bg-white shadow-market-lg"
          role="dialog"
          aria-label="ELEMARKET customer support"
        >
          <header className="flex items-center justify-between border-b border-market-line px-3.5 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-market-soft text-market-green">
                <Headphones size={16} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-black">ELEMARKET Support</p>
                <p className="truncate text-[10px] text-market-muted">{statusLabel(conversation?.status)}</p>
              </div>
            </div>
            <button ref={closeButton} type="button" onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-lg text-market-muted hover:bg-market-soft" aria-label="Close support chat">
              <X size={16} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto bg-market-bg/60 p-3" aria-live="polite">
            {isPending || loading ? <p role="status" className="rounded-xl bg-white p-3 text-xs text-market-muted">Opening secure support…</p> : null}
            {sessionStalled && isPending ? (
              <div role="alert" className="mt-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
                Your sign-in session is taking too long to load. Check your connection and try reloading the page.
                <button type="button" onClick={() => window.location.reload()} className="ml-2 font-bold underline">Reload</button>
              </div>
            ) : null}
            {!isPending && !user ? (
              <div className="rounded-2xl border border-market-line bg-white p-4 text-sm">
                <p className="font-black">Sign in to chat securely</p>
                <p className="mt-1 text-xs leading-5 text-market-muted">Your support conversation is tied to your customer account so another shopper cannot read it.</p>
                <a href="/login" className="mt-3 inline-flex rounded-xl bg-market-green px-4 py-2.5 text-xs font-black text-white">Sign in or create account</a>
              </div>
            ) : null}
            {user && conversation?.messages.length === 0 ? (
              <div className="rounded-2xl bg-white p-4 text-sm text-market-muted shadow-sm">
                {mode === "order" ? "Tell us what you need help with for your order or checkout." : "Tell us what you need help with. You can keep shopping while this chat stays open."}
              </div>
            ) : null}
            {conversation?.draft ? (
              <div className="mb-3 rounded-2xl border border-market-green/20 bg-white p-3 text-xs">
                <p className="font-black">Support prepared an order draft</p>
                <p className="mt-1 text-market-muted">Review the live price, stock and delivery details before payment.</p>
                <a href={`/checkout?draftId=${encodeURIComponent(String((conversation.draft as { draftId?: string }).draftId ?? ""))}`} className="mt-2 inline-flex rounded-lg bg-market-orange px-3 py-2 font-black text-white">Review draft</a>
              </div>
            ) : null}
            <div className="space-y-2.5">
              {conversation?.messages.map((message) => (
                <div key={message.id} className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-5 ${message.senderType === "customer" ? "ml-auto bg-market-green text-white" : "bg-white text-market-ink shadow-sm"}`}>
                  <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body}</span>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
            {error ? <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{error}{!loading && !conversation ? <button type="button" onClick={retry} className="ml-2 underline">Retry</button> : null}</p> : null}
          </div>

          {user ? (
            <div className="border-t border-market-line bg-white p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value.slice(0, 4000))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  maxLength={4000}
                  disabled={busy || !conversation || conversation.status === "closed"}
                  placeholder={conversation?.status === "closed" ? "This conversation is closed" : "Write a message…"}
                  className="min-h-11 flex-1 resize-none rounded-xl border border-market-line px-3 py-2.5 text-sm outline-none focus:border-market-green disabled:bg-market-soft"
                  aria-label="Support message"
                />
                <button type="button" onClick={() => void send()} disabled={busy || !body.trim() || !conversation || conversation.status === "closed"} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-market-orange text-white disabled:opacity-40" aria-label="Send support message">
                  <Send size={16} />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <a href={orderId ? `/support?orderId=${encodeURIComponent(orderId)}` : "/support"} className="text-[10px] font-bold text-market-green">Open full support view</a>
                {contactItems.map(({ label, href }) => <a key={label} href={href} className="text-[10px] font-semibold text-market-muted hover:text-market-green">{label}</a>)}
              </div>
            </div>
          ) : contactItems.length > 0 ? (
            <div className="flex flex-wrap gap-2 border-t border-market-line p-3">
              {contactItems.map(({ label, href, icon: Icon }) => (
                <a key={label} href={href} className="inline-flex items-center gap-1.5 rounded-lg border border-market-line px-2.5 py-2 text-[10px] font-bold text-market-ink">
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
          className="inline-flex h-10 items-center gap-2 rounded-full border border-market-line bg-white px-3.5 text-[11px] font-black text-market-ink shadow-market hover:border-market-green/30 hover:bg-market-soft"
          aria-expanded={false}
          aria-label={mode === "order" ? "Open order support chat" : "Open ELEMARKET support chat"}
        >
          <MessageCircle size={15} className="text-market-green" aria-hidden="true" />
          {mode === "order" ? "Order Support" : "Chat Support"}
        </button>
      )}
    </div>
  );
}
