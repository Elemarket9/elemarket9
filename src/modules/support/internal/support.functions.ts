import type { JsonValue } from "@/lib/db-types";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireRoleForUserId } from "@/modules/identity/public/auth/authorization.server";
import { getSql } from "@/lib/db";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const conversationInput = z.object({ orderId: z.string().trim().min(1).max(64).nullable().optional() });
const conversationIdInput = z.object({ conversationId: z.string().trim().min(1).max(80) });
const messageInput = conversationIdInput.extend({ body: z.string().trim().min(1).max(4000), idempotencyKey: z.string().trim().min(16).max(128) });

export type CustomerSupportState = {
  id: string;
  status: "open" | "waiting_customer" | "waiting_support" | "resolved" | "closed";
  messages: Array<{ id: string; senderType: "customer" | "support"; body: string; createdAt: string }>;
  draft: JsonValue;
};

async function loadOwnedConversation(userId: string, conversationId: string): Promise<CustomerSupportState> {
  const sql = await getSql();
  const conversations = await sql.query<{ id: string; status: CustomerSupportState["status"] }>(
    `select id,status from support_conversations where id=$1 and customer_id=$2 limit 1`, [conversationId,userId],
  );
  const conversation = conversations[0];
  if (!conversation) throw new Error("Support conversation unavailable");
  const messages = await sql.query<CustomerSupportState["messages"][number]>(
    `select m.id,m.sender_type as "senderType",m.body,m.created_at as "createdAt"
       from support_messages m join support_conversations c on c.id=m.conversation_id
      where m.conversation_id=$1 and c.customer_id=$2
      order by m.created_at desc,m.id desc limit 200`, [conversationId,userId],
  );
  messages.reverse();
  // Chat must remain usable when an optional assisted-order draft contains a
  // sold-out/deactivated product. get_assisted_order_draft() performs checkout
  // availability checks and can THROW; calling it here made opening the entire
  // support thread fail even though its messages were still accessible.
  // Return only the customer's already-stored draft reference/quantities here.
  // The checkout flow must continue to validate stock, prices and eligibility.
  const draftRows = await sql.query<{ result: JsonValue }>(
    `select jsonb_build_object('draftId',d.id,'expiresAt',d.expires_at,'items',d.items) as result
       from support_order_drafts d
      where d.conversation_id=$2 and d.customer_id=$1
        and d.status='pending' and d.expires_at>now()
      order by d.updated_at desc limit 1`, [userId,conversationId],
  );
  return { id: conversation.id, status: conversation.status, messages, draft: draftRows[0]?.result ?? null };
}

export const getSupportConversation = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(conversationInput)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireRoleForUserId(["customer", "merchant"], userId);
    await enforceRateLimit("support-conversation-open", { windowSeconds: 60, maxRequests: 20, subject: userId });
    const sql = await getSql();
    const rows = await sql.query<{ id: string }>(
      `with identity as (select set_config('app.user_id',$1,true)) select create_support_conversation($1,$2) as id from identity`,
      [userId, data.orderId ?? null],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("Support conversation unavailable");
    return loadOwnedConversation(userId,id);
  });

export const refreshSupportConversation = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(conversationIdInput)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireRoleForUserId(["customer", "merchant"], userId);
    await enforceRateLimit("support-thread-refresh", { windowSeconds: 60, maxRequests: 12, subject: userId });
    return loadOwnedConversation(userId,data.conversationId);
  });

export const sendSupportMessage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(messageInput)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireRoleForUserId(["customer", "merchant"], userId);
    await enforceRateLimit("support-message-send", { windowSeconds: 60, maxRequests: 20, subject: userId });
    const sql = await getSql();
    const rows = await sql.query<{ result: JsonValue }>(
      `with identity as (select set_config('app.user_id',$1,true)) select append_customer_support_message($1,$2,$3,$4) as result from identity`,
      [userId, data.conversationId, data.body, data.idempotencyKey],
    );
    return rows[0]?.result ?? null;
  });

export const getAssistedOrderDraft = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ draftId: z.string().trim().min(1).max(80) }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireRoleForUserId(["customer", "merchant"], userId);
    await enforceRateLimit("support-assisted-draft-read", { windowSeconds: 60, maxRequests: 30, subject: userId });
    const sql = await getSql();
    const rows = await sql.query<{ result: JsonValue }>("select get_assisted_order_draft($1,$2) as result", [userId, data.draftId]);
    return rows[0]?.result ?? null;
  });
