import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getAuthenticatedUserId, authMiddleware } from "@/modules/identity/public/auth/middleware";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { getSql } from "@/lib/db";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import type { JsonObject, JsonValue } from "@/lib/db-types";

export type SupportPriority = "low" | "normal" | "high" | "urgent";
export type SupportStatus = "open" | "waiting_customer" | "waiting_support" | "resolved" | "closed";
export type SupportInboxRow = { id:string; customerId:string; customerName:string|null; customerEmail:string|null; orderId:string|null; status:SupportStatus; priority:SupportPriority; assignedAdminId:string|null; assignedAdminName:string|null; assignedToMe:boolean; updatedAt:string; lastMessage:string|null };
export type SupportThreadMessage = { id:string; senderType:"customer"|"support"; body:string; createdAt:string };
export type SupportInternalNote = { id:string; adminId:string; adminName:string|null; body:string; createdAt:string };
export type SupportThread = { conversation:Omit<SupportInboxRow,"lastMessage">; messages:SupportThreadMessage[]; notes:SupportInternalNote[] };
export type AssistedProductRow = { id:string; name:string; price:string; stock:number; merchantId:string; merchantName:string; variants:JsonValue[] };

const conversationIdSchema=z.object({conversationId:z.string().trim().min(1).max(80)});
const replySchema=conversationIdSchema.extend({body:z.string().trim().min(1).max(4000),idempotencyKey:z.string().trim().min(16).max(128)});

export const listSupportInbox=createServerFn({method:"GET"}).middleware([authMiddleware]).handler(async({context})=>{
  const adminId=getAuthenticatedUserId(context); await requireAdminForUserId(adminId, "admin.support");
  await enforceRateLimit("admin-support-read",{windowSeconds:60,maxRequests:60,subject:adminId});
  const sql=await getSql();
  return sql.query<SupportInboxRow>(`select c.id,c.customer_id as "customerId",u.name as "customerName",u.email as "customerEmail",c.order_id as "orderId",c.status,c.priority,c.assigned_admin_id as "assignedAdminId",au.name as "assignedAdminName",(c.assigned_admin_id=$1) as "assignedToMe",c.updated_at as "updatedAt",
    (select left(m.body,240) from support_messages m where m.conversation_id=c.id order by m.created_at desc,m.id desc limit 1) as "lastMessage"
    from support_conversations c join "user" u on u.id=c.customer_id left join "user" au on au.id=c.assigned_admin_id
    where c.status in ('open','waiting_support','waiting_customer','resolved')
    order by case c.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,c.updated_at desc limit 100`,[adminId]);
});

export const getSupportThread=createServerFn({method:"GET"}).middleware([authMiddleware]).validator(conversationIdSchema).handler(async({data,context})=>{
  const adminId=getAuthenticatedUserId(context); await requireAdminForUserId(adminId, "admin.support");
  await enforceRateLimit("admin-support-thread-read",{windowSeconds:60,maxRequests:120,subject:adminId});
  const sql=await getSql();
  const rows=await sql.query<Omit<SupportInboxRow,"lastMessage">>(`select c.id,c.customer_id as "customerId",u.name as "customerName",u.email as "customerEmail",c.order_id as "orderId",c.status,c.priority,c.assigned_admin_id as "assignedAdminId",au.name as "assignedAdminName",(c.assigned_admin_id=$2) as "assignedToMe",c.updated_at as "updatedAt" from support_conversations c join "user" u on u.id=c.customer_id left join "user" au on au.id=c.assigned_admin_id where c.id=$1 limit 1`,[data.conversationId,adminId]);
  const conversation=rows[0]; if(!conversation) throw new Error("Support conversation not found");
  const [messages,notes]=await Promise.all([
    sql.query<SupportThreadMessage>(`select id,sender_type as "senderType",body,created_at as "createdAt" from support_messages where conversation_id=$1 order by created_at desc,id desc limit 300`,[data.conversationId]),
    sql.query<SupportInternalNote>(`select n.id,n.admin_id as "adminId",u.name as "adminName",n.body,n.created_at as "createdAt" from support_internal_notes n join "user" u on u.id=n.admin_id where n.conversation_id=$1 order by n.created_at desc,n.id desc limit 300`,[data.conversationId]),
  ]);
  messages.reverse();
  notes.reverse();
  return {conversation,messages,notes} satisfies SupportThread;
});

export const replySupportThread=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(replySchema).handler(async({data,context})=>{
  const adminId=getAuthenticatedUserId(context); await requireAdminForUserId(adminId, "admin.support"); await enforceRateLimit("admin-support-reply",{windowSeconds:60,maxRequests:60,subject:adminId}); const sql=await getSql();
  const rows=await sql.query<{result:JsonValue}>(`with identity as (select set_config('app.user_id',$1,true)) select append_support_agent_message($1,$2,$3,$4) as result from identity`,[adminId,data.conversationId,data.body,data.idempotencyKey]); return rows[0]?.result??null;
});

export const addSupportInternalNote=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(replySchema).handler(async({data,context})=>{
  const adminId=getAuthenticatedUserId(context); await requireAdminForUserId(adminId, "admin.support"); await enforceRateLimit("admin-support-internal-note",{windowSeconds:60,maxRequests:30,subject:adminId}); const sql=await getSql();
  const rows=await sql.query<{result:JsonValue}>(`with identity as (select set_config('app.user_id',$1,true)) select add_support_internal_note($1,$2,$3,$4) as result from identity`,[adminId,data.conversationId,data.body,data.idempotencyKey]); return rows[0]?.result??null;
});

const stateSchema=conversationIdSchema.extend({action:z.enum(["claim","unclaim","resolve","reopen","close","set_priority"]),priority:z.enum(["low","normal","high","urgent"]).nullable().optional()});
export const updateSupportConversationState=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(stateSchema).handler(async({data,context})=>{
  const adminId=getAuthenticatedUserId(context); await requireAdminForUserId(adminId, "admin.support"); await enforceRateLimit("admin-support-state",{windowSeconds:60,maxRequests:40,subject:adminId}); const sql=await getSql();
  const rows=await sql.query<{result:JsonValue}>(`with identity as (select set_config('app.user_id',$1,true)) select update_support_conversation_state($1,$2,$3,$4) as result from identity`,[adminId,data.conversationId,data.action,data.priority??null]); return rows[0]?.result??null;
});

const assistedDraftSchema=z.object({conversationId:z.string().trim().min(1).max(80),items:z.array(z.object({productId:z.string().trim().min(1).max(64),variantId:z.string().trim().min(1).max(64).nullable().optional(),quantity:z.number().int().min(1).max(20)})).min(1).max(40)});
export const createAssistedOrderDraft=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(assistedDraftSchema).handler(async({data,context})=>{
  const adminId=getAuthenticatedUserId(context); await requireAdminForUserId(adminId, "admin.support"); await enforceRateLimit("admin-support-assisted-order",{windowSeconds:60,maxRequests:20,subject:adminId}); const sql=await getSql();
  const rows=await sql.query<{result:JsonObject}>(`with identity as (select set_config('app.user_id',$1,true)) select create_assisted_order_draft($1,$2,$3::jsonb) as result from identity`,[adminId,data.conversationId,JSON.stringify(data.items)]); return rows[0]?.result??null;
});

export const searchProductsForAssistedOrder=createServerFn({method:"GET"}).middleware([authMiddleware]).validator(z.object({q:z.string().trim().min(2).max(80)})).handler(async({data,context})=>{
  const adminId=getAuthenticatedUserId(context); await requireAdminForUserId(adminId, "admin.support"); await enforceRateLimit("admin-support-assisted-product-search",{windowSeconds:60,maxRequests:60,subject:adminId}); const sql=await getSql();
  return sql.query<AssistedProductRow>(`select p.id,p.name,p.price::text as price,p.stock,p.merchant_id as "merchantId",m.name as "merchantName",coalesce((select jsonb_agg(jsonb_build_object('id',pv.id,'name',coalesce(pv.name,pv.sku),'price',pv.price::text,'stock',pv.stock) order by pv.id) from product_variants pv where pv.product_id=p.id and pv.status='active' and pv.stock>0),'[]'::jsonb) as variants from products p join merchants m on m.id=p.merchant_id where m.status='active' and m.verified=true and p.status='active' and p.stock>0 and (p.name ilike '%'||$1||'%' escape '\\' or coalesce(p.sku,'') ilike '%'||$1||'%' escape '\\') order by p.name limit 20`,[data.q.replace(/[%_\\]/g,"\\$&")]);
});
