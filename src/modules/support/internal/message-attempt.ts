export type MessageAttempt = { conversationId: string; body: string; idempotencyKey: string };

/** A lost response must be retried with the same key, not a second message. */
export function messageAttempt(previous: MessageAttempt | null, conversationId: string, body: string): MessageAttempt {
  const text = body.trim();
  if (previous?.conversationId === conversationId && previous.body === text) return previous;
  return { conversationId, body: text, idempotencyKey: crypto.randomUUID() };
}
