import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSupportConversation,
  refreshSupportConversation,
  sendSupportMessage,
  type CustomerSupportState,
} from "./support.functions";
import { messageAttempt, type MessageAttempt } from "./message-attempt";
import { withSupportRequestTimeout } from "./request-timeout";

/** Used by both customer support surfaces. Callers key the view by account/order. */
export function useCustomerSupportChat(
  userId: string | null,
  orderId: string | null,
  enabled: boolean,
) {
  const [conversation, setConversation] = useState<CustomerSupportState | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const generation = useRef(0);
  const readVersion = useRef(0);
  const sending = useRef(false);
  const pendingAttempt = useRef<MessageAttempt | null>(null);
  const polling = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    setBusy(false);
    setConversation(null);
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
          setError("Support did not open. Check your connection and select Retry.");
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
    if (generation.current === current && readVersion.current === version) setConversation(next);
  }, [conversationId]);

  useEffect(() => {
    if (!enabled || !userId || !conversationId) return;
    const poll = async () => {
      if (document.visibilityState !== "visible" || polling.current || sending.current) return;
      polling.current = true;
      try {
        await refresh();
      } catch {
        /* Preserve the last loaded thread on a transient polling failure. */
      } finally {
        polling.current = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 12_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [conversationId, enabled, refresh, userId]);

  async function send() {
    if (
      !body.trim() ||
      !conversationId ||
      !enabled ||
      !userId ||
      sending.current ||
      conversation?.status === "closed"
    )
      return;
    const current = generation.current;
    const attempt = messageAttempt(pendingAttempt.current, conversationId, body);
    pendingAttempt.current = attempt;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await withSupportRequestTimeout(sendSupportMessage({ data: attempt }));
      if (generation.current !== current) return;
      pendingAttempt.current = null;
      setBody("");
      try {
        await refresh();
      } catch {
        if (generation.current === current)
          setError(
            "Your message was sent. The conversation could not refresh; it will retry automatically.",
          );
      }
    } catch {
      if (generation.current === current)
        setError("Message could not be confirmed. Retry to check or send it safely.");
    } finally {
      sending.current = false;
      if (generation.current === current) setBusy(false);
    }
  }

  return {
    conversation,
    body,
    setBody,
    busy,
    loading,
    error,
    send,
    retry: () => setRetryCount((value) => value + 1),
  };
}
