import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSupportConversation,
  getSupportUnreadCount,
  refreshSupportConversation,
  sendSupportMessage,
  type CustomerSupportState,
} from "./support.functions";
import { messageAttempt, type MessageAttempt } from "./message-attempt";
import { withSupportRequestTimeout } from "./request-timeout";

/** A message the customer has sent that the server has not confirmed yet. */
export type OutgoingMessage = { body: string; state: "sending" | "failed" };

const draftKey = (userId: string, orderId: string | null) => `elemarket:support-draft:${userId}:${orderId ?? "general"}`;
// Browser storage can be unavailable (private mode, blocked): the chat must work without it.
function readDraft(key: string): string {
  try { return window.sessionStorage.getItem(key) ?? ""; } catch { return ""; }
}
function writeDraft(key: string, value: string) {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch { /* typing still works; only the saved draft is lost */ }
}

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** Used by both customer support surfaces. Callers key the view by account/order. */
export function useCustomerSupportChat(
  userId: string | null,
  orderId: string | null,
  enabled: boolean,
) {
  const [conversation, setConversation] = useState<CustomerSupportState | null>(null);
  const [body, setBodyState] = useState("");
  const [outgoing, setOutgoing] = useState<OutgoingMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const online = useOnline();
  const generation = useRef(0);
  const readVersion = useRef(0);
  const sending = useRef(false);
  const pendingAttempt = useRef<MessageAttempt | null>(null);
  const polling = useRef(false);

  // A half-written message survives closing the chat or a page reload.
  useEffect(() => {
    if (userId) setBodyState(readDraft(draftKey(userId, orderId)));
  }, [userId, orderId]);
  const setBody = useCallback((value: string) => {
    setBodyState(value);
    if (userId) writeDraft(draftKey(userId, orderId), value);
  }, [userId, orderId]);

  useEffect(() => {
    const current = ++generation.current;
    setConversation(null);
    setOutgoing(null);
    readVersion.current += 1;
    pendingAttempt.current = null;
    setLoading(false);
    if (!enabled || !userId) return;
    setLoading(true);
    setError(null);
    const version = ++readVersion.current;
    void withSupportRequestTimeout(getSupportConversation({ data: { orderId } }))
      .then((state) => {
        if (generation.current === current && readVersion.current === version)
          setConversation(state);
      })
      .catch(() => {
        if (generation.current === current)
          setError("Support did not open. Check your connection and try again.");
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current += 1;
    };
  }, [enabled, orderId, retryCount, userId]);

  const conversationId = conversation?.id;
  const refresh = useCallback(async () => {
    if (!conversationId) return;
    const current = generation.current;
    const version = ++readVersion.current;
    const next = await withSupportRequestTimeout(refreshSupportConversation({ data: { conversationId } }));
    if (generation.current === current && readVersion.current === version) {
      setConversation(next);
      setStale(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (!enabled || !userId || !conversationId) return;
    let failures = 0;
    const poll = async () => {
      if (document.visibilityState !== "visible" || polling.current || sending.current) return;
      polling.current = true;
      try {
        await refresh();
        failures = 0;
      } catch {
        // Keep the last loaded thread, but tell the customer it may be out of date.
        failures += 1;
        if (failures >= 2) setStale(true);
      } finally {
        polling.current = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 12_000);
    const onWake = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [conversationId, enabled, refresh, userId]);

  /** Sends `text`, or retries the unconfirmed message with the SAME idempotency key. */
  const deliver = useCallback(async (text: string) => {
    if (!text.trim() || !conversationId || !enabled || !userId || sending.current || conversation?.status === "closed") return;
    const current = generation.current;
    const attempt = messageAttempt(pendingAttempt.current, conversationId, text);
    pendingAttempt.current = attempt;
    sending.current = true;
    setOutgoing({ body: attempt.body, state: "sending" });
    setError(null);
    try {
      await withSupportRequestTimeout(sendSupportMessage({ data: attempt }));
      if (generation.current !== current) return;
      pendingAttempt.current = null;
      try {
        await refresh();
      } catch {
        // Sent, but the thread could not reload: keep showing the message until the next poll.
        if (generation.current === current) setStale(true);
      }
      if (generation.current === current) setOutgoing(null);
    } catch {
      if (generation.current === current) setOutgoing({ body: attempt.body, state: "failed" });
    } finally {
      sending.current = false;
    }
  }, [conversation?.status, conversationId, enabled, refresh, userId]);

  const send = useCallback(async () => {
    // One unconfirmed message at a time, so a retry can never duplicate or reorder.
    if (outgoing) return;
    const text = body.trim();
    if (!text) return;
    setBody("");
    await deliver(text);
  }, [body, deliver, outgoing, setBody]);

  const retrySend = useCallback(async () => {
    if (outgoing?.state === "failed") await deliver(outgoing.body);
  }, [deliver, outgoing]);

  /** Give up on a failed message and put its text back in the box. */
  const discardFailed = useCallback(() => {
    if (outgoing?.state !== "failed") return;
    pendingAttempt.current = null;
    setBody(body ? `${outgoing.body}\n${body}` : outgoing.body);
    setOutgoing(null);
  }, [body, outgoing, setBody]);

  // Failed while offline: send again by itself when the connection returns.
  useEffect(() => {
    if (online && outgoing?.state === "failed") void retrySend();
    // Only react to the connection coming back, not to every failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  return {
    conversation,
    body,
    setBody,
    busy: outgoing?.state === "sending",
    outgoing,
    loading,
    error,
    stale,
    online,
    send,
    retrySend,
    discardFailed,
    retry: () => setRetryCount((value) => value + 1),
  };
}

/**
 * Unread support replies for the chat button's badge. Polls gently (once a
 * minute, only while the page is visible) and never throws: a badge is a
 * convenience, the thread itself is the source of truth.
 */
export function useSupportUnread(userId: string | null, enabled: boolean): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!userId || !enabled) {
      setUnread(0);
      return;
    }
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const result = await withSupportRequestTimeout(getSupportUnreadCount(), 15_000);
        if (!cancelled) setUnread(result.unread);
      } catch { /* keep the last known value */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), 60_000);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, enabled]);
  return unread;
}
