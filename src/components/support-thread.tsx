import { useEffect, useRef } from "react";
import { AlertCircle, Clock, Send, WifiOff } from "lucide-react";
import type { CustomerSupportState } from "@/modules/support/public/support.functions";

import type { OutgoingMessage } from "@/modules/support/public/use-customer-support-chat";

/**
 * The customer's support conversation: one implementation for the floating
 * chat and the full /support page (they used to be two separate copies).
 */

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" });

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString("en-GH", { weekday: "short", day: "numeric", month: "short" });
}

export function SupportMessages({
  conversation, outgoing, loading, error, stale, online, emptyText, onRetryOpen, onRetrySend, onDiscard,
}: {
  conversation: CustomerSupportState | null;
  outgoing: OutgoingMessage | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  online: boolean;
  emptyText: string;
  onRetryOpen: () => void;
  onRetrySend: () => void;
  onDiscard: () => void;
}) {
  const end = useRef<HTMLDivElement | null>(null);
  const count = conversation?.messages.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [count, outgoing?.state]);

  let lastDay = "";
  return (
    <div className="space-y-2.5" role="log" aria-label="Support messages" aria-live="polite">
      {!online ? (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-900">
          <WifiOff size={14} aria-hidden="true" /> You're offline. Messages will send when your connection is back.
        </p>
      ) : stale ? (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-900">
          <Clock size={14} aria-hidden="true" /> Having trouble reaching ELEMARKET. Showing the last messages we loaded; still trying.
        </p>
      ) : null}
      {loading ? <p role="status" className="rounded-xl bg-white p-3 text-sm text-market-muted">Opening secure support…</p> : null}
      {error ? (
        <div role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">
          {error}
          {!loading && !conversation ? (
            <button type="button" onClick={onRetryOpen} className="mt-2 block min-h-11 rounded-lg border border-red-200 bg-white px-4 text-sm font-black text-red-700">Try again</button>
          ) : null}
        </div>
      ) : null}
      {conversation && count === 0 && !outgoing ? (
        <p className="rounded-2xl bg-white p-4 text-sm leading-6 text-market-muted shadow-sm">{emptyText}</p>
      ) : null}
      {conversation?.messages.map((message) => {
        const day = dayLabel(message.createdAt);
        const showDay = day !== lastDay;
        lastDay = day;
        const mine = message.senderType === "customer";
        return (
          <div key={message.id}>
            {showDay ? <p className="py-1 text-center text-xs font-bold text-market-muted">{day}</p> : null}
            <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-5 ${mine ? "bg-market-green text-white" : "bg-white text-market-ink shadow-sm"}`}>
                {!mine ? <p className="mb-0.5 text-xs font-black text-market-green">ELEMARKET Support</p> : null}
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body}</p>
                <p className={`mt-1 text-right text-xs ${mine ? "text-white/80" : "text-market-muted"}`}>{timeOf(message.createdAt)}{mine ? " · Sent" : ""}</p>
              </div>
            </div>
          </div>
        );
      })}
      {outgoing ? (
        <div className="flex justify-end">
          <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-5 ${outgoing.state === "failed" ? "border border-red-300 bg-red-50 text-red-900" : "bg-market-green/70 text-white"}`}>
            <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{outgoing.body}</p>
            {outgoing.state === "sending" ? (
              <p role="status" className="mt-1 text-right text-xs text-white/90">Sending…</p>
            ) : (
              <div role="alert" className="mt-2">
                <p className="flex items-center gap-1.5 text-xs font-bold"><AlertCircle size={13} aria-hidden="true" /> Not sent. Nothing was lost.</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={onRetrySend} className="min-h-11 flex-1 rounded-lg bg-red-700 px-3 text-sm font-black text-white">Send again</button>
                  <button type="button" onClick={onDiscard} className="min-h-11 rounded-lg border border-red-300 bg-white px-3 text-sm font-bold text-red-800">Edit</button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
      <div ref={end} />
    </div>
  );
}

export function SupportComposer({
  body, setBody, send, disabled, closed, waitingForSend,
}: {
  body: string;
  setBody: (value: string) => void;
  send: () => void;
  disabled: boolean;
  closed: boolean;
  /** A previous message is still unconfirmed; typing stays enabled, sending waits. */
  waitingForSend: boolean;
}) {
  return (
    <div className="flex items-end gap-2">
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value.slice(0, 4000))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!waitingForSend) send();
          }
        }}
        rows={2}
        maxLength={4000}
        disabled={disabled || closed}
        placeholder={closed ? "This conversation is closed" : "Write a message…"}
        className="min-h-12 flex-1 resize-none rounded-xl border border-market-line px-3 py-2.5 text-base outline-none focus:border-market-green disabled:bg-market-soft sm:text-sm"
        aria-label="Support message"
      />
      <button
        type="button"
        onClick={send}
        disabled={disabled || closed || waitingForSend || !body.trim()}
        className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-market-orange text-white disabled:opacity-40"
        aria-label="Send support message"
      >
        <Send size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
