import {randomUUID} from "node:crypto";
import {createServerFn} from "@tanstack/react-start";
import {z} from "zod";
import {authMiddleware,getAuthenticatedUserId} from "@/modules/identity/public/auth/middleware";
import {requireFreshSession} from "@/modules/identity/public/auth/verify.server";
import {requireMerchantAccessForUserId,requireAdminForUserId} from "@/modules/identity/public/auth/authorization.server";
import {getSql,withTransaction} from "@/lib/db";
import type {JsonObject} from "@/lib/db-types";
import {enforceRateLimit} from "@/lib/security/rate-limit.server";
const id=z.string().trim().min(1).max(128);
export const loadMyShipmentReturns=createServerFn({method:'GET'}).middleware([authMiddleware]).handler(async({context})=>{
 const actor=getAuthenticatedUserId(context);const sql=await getSql();
 const items=await sql.query<{shipmentId:string;orderItemId:number;name:string;quantity:number}>(`select s.id as "shipmentId",i.id::int as "orderItemId",p.name,si.quantity
  from shipments s join orders o on o.id=s.order_id and o.user_id=$1 join shipment_items si on si.shipment_id=s.id
  join order_items i on i.id=si.order_item_id join products p on p.id=i.product_id where s.delivered_at is not null order by s.delivered_at desc limit 200`,[actor]);
 const requests=await sql.query<JsonObject>(`select r.id,r.shipment_id as "shipmentId",r.order_item_id::int as "orderItemId",r.quantity,r.status,r.refund_amount::text as "refundAmount",r.provider_refund_request_id as "providerRefundRequestId"
  from return_requests r where r.customer_id=$1 order by r.created_at desc limit 100`,[actor]);return {items,requests};
});
export const requestShipmentReturn=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({shipmentId:id,orderItemId:z.number().int().positive(),quantity:z.number().int().min(1).max(20),reasonCode:z.enum(['changed_mind','wrong_item','damaged','defective','not_as_described','missing_parts','other']),reason:z.string().trim().min(12).max(2000),idempotencyKey:z.string().uuid()})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);await requireFreshSession();await enforceRateLimit('shipment-return-request',{windowSeconds:3600,maxRequests:15,subject:actor});
 return withTransaction(async tx=>{
  const order=(await tx.query<{id:string;merchant_id:string}>(`select o.id,o.merchant_id from orders o join shipments s on s.order_id=o.id where s.id=$1 and o.user_id=$2 for update of o`,[data.shipmentId,actor]))[0];
  if(!order)throw new Error('Shipment unavailable');
  const prior=(await tx.query<{id:string;shipment_id:string;order_item_id:number;quantity:number}>(`select id,shipment_id,order_item_id::int,quantity from return_requests where customer_id=$1 and client_request_key=$2`,[actor,data.idempotencyKey]))[0];
  if(prior){if(prior.shipment_id!==data.shipmentId||prior.order_item_id!==data.orderItemId||prior.quantity!==data.quantity)throw new Error('Idempotency key reused for a different return');return {returnId:prior.id,replayed:true};}
  const valid=await tx.query(`select s.id from shipments s join shipment_items si on si.shipment_id=s.id and si.order_item_id=$2
   join order_items i on i.id=si.order_item_id join products p on p.id=i.product_id
   where s.id=$1 and s.delivered_at is not null and p.returnable and now()<=s.delivered_at+make_interval(days=>p.return_window_days)
   and si.quantity>=$3 for update of s`,[data.shipmentId,data.orderItemId,data.quantity]);
  if(!valid[0])throw new Error('Item is unavailable or outside the shipment return window');
  const payment=(await tx.query<{id:string}>(`select id from payments where order_id=$1 and user_id=$2 and status='completed' for update`,[order.id,actor]))[0];
  if(!payment)throw new Error('Verified payment record required for a return request');
  const key=`return_${randomUUID()}`;
  await tx.query(`insert into return_requests(id,order_id,order_item_id,customer_id,merchant_id,reason_code,reason,quantity,shipment_id,payment_id,client_request_key)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[key,order.id,data.orderItemId,actor,order.merchant_id,data.reasonCode,data.reason,data.quantity,data.shipmentId,payment.id,data.idempotencyKey]);
  await tx.query(`select record_audit_event('shipment.return.requested','return_request',$1,$2,'customer',null,'success',jsonb_build_object('shipmentId',$3::text,'orderItemId',$4::bigint,'quantity',$5::int))`,[key,actor,data.shipmentId,data.orderItemId,data.quantity]);
  return {returnId:key,replayed:false};
 });
});
export const reviewShipmentReturn=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({returnId:id,action:z.enum(['approved','rejected','received','refund_pending','reconcile']),reason:z.string().trim().min(12).max(1000),providerRefundRequestId:id.optional()})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);await requireFreshSession();const sql=await getSql();
 const scope=(await sql.query<{merchant_id:string;order_id:string}>(`select merchant_id,order_id from return_requests where id=$1`,[data.returnId]))[0];
 if(!scope)throw new Error('Return unavailable');
 const role=(await sql.query<{role:string}>(`select role from "user" where id=$1`,[actor]))[0];
 if(role?.role==='admin')await requireAdminForUserId(actor,'admin.finance.refunds');else await requireMerchantAccessForUserId(scope.merchant_id,actor);
 return withTransaction(async tx=>{
  await tx.query(`select id from orders where id=$1 for update`,[scope.order_id]);
  const row=(await tx.query<{status:string;provider_refund_request_id:string|null}>(`select status,provider_refund_request_id from return_requests where id=$1 for update`,[data.returnId]))[0];
  const next=data.action==='reconcile'?'refunded':data.action;
  const allowed:Record<string,string[]>={requested:['approved','rejected'],approved:['received','rejected'],received:['refund_pending'],refund_pending:['refunded']};
  if(!(allowed[row.status]??[]).includes(next))throw new Error('Invalid return lifecycle transition');
  const refund=data.providerRefundRequestId??row.provider_refund_request_id;
  if(['refund_pending','refunded'].includes(next)&&!refund)throw new Error('Existing provider-managed refund request reference required; no refund is invented');
  await tx.query(`update return_requests set status=$2,resolution_note=$3,resolved_by=$4,provider_refund_request_id=coalesce($5,provider_refund_request_id),updated_at=now() where id=$1`,[data.returnId,next,data.reason,actor,refund]);
  await tx.query(`select record_audit_event('shipment.return.reviewed','return_request',$1,$2,'merchant',null,'success',jsonb_build_object('status',$3::text,'providerRefundRequestId',$4::text))`,[data.returnId,actor,next,refund]);
  return {status:next,externalRefundExecuted:false};
 });
});
export const loadMerchantShipmentReturns=createServerFn({method:'GET'}).middleware([authMiddleware])
 .validator(z.object({merchantId:id})).handler(async({data,context})=>{
 await requireMerchantAccessForUserId(data.merchantId,getAuthenticatedUserId(context));const sql=await getSql();
 return sql.query<JsonObject>(`select id,shipment_id as "shipmentId",order_id as "orderId",order_item_id::int as "orderItemId",quantity,status,reason,refund_amount::text as "refundAmount",provider_refund_request_id as "refundRequestId" from return_requests where merchant_id=$1 order by created_at desc limit 100`,[data.merchantId]);
});
