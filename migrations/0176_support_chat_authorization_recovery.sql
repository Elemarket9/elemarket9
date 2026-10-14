-- Additive support fixes. This does not replace missing historical 0105.
create or replace function create_support_conversation(p_customer_id text,p_order_id text default null) returns text language plpgsql as $$
declare v_id text; v_owner text; v_role text; v_lock text;
begin
 if p_customer_id is null or length(trim(p_customer_id))<1 then raise exception 'customer identity required'; end if;
 if current_setting('app.user_id',true) is distinct from p_customer_id then raise exception 'unauthorized'; end if;
 select role into v_role from "user" where id=p_customer_id; if v_role is distinct from 'customer' then raise exception 'customer role required'; end if;
 v_lock:='elemarket:support-conversation:'||p_customer_id||':'||coalesce(p_order_id,'general'); perform pg_advisory_xact_lock(hashtextextended(v_lock,0));
 if p_order_id is not null then select user_id into v_owner from orders where id=p_order_id for share; if not found then raise exception 'order not found'; end if; if v_owner<>p_customer_id then raise exception 'customer does not own order'; end if; end if;
 select id into v_id from support_conversations where customer_id=p_customer_id and ((p_order_id is null and order_id is null) or order_id=p_order_id) and status in ('open','waiting_customer','waiting_support') order by updated_at desc limit 1;
 if found then return v_id; end if;
 v_id:='sup_'||replace(gen_random_uuid()::text,'-',''); insert into support_conversations(id,customer_id,order_id,status) values(v_id,p_customer_id,p_order_id,'open'); return v_id;
end $$;

create or replace function append_customer_support_message(p_customer_id text,p_conversation_id text,p_body text,p_idempotency_key text) returns jsonb language plpgsql as $$
declare v_conversation record; v_id text; v_existing record; v_hash text; v_role text;
begin
 if current_setting('app.user_id',true) is distinct from p_customer_id then raise exception 'unauthorized'; end if;
 select role into v_role from "user" where id=p_customer_id; if v_role is distinct from 'customer' then raise exception 'customer role required'; end if;
 if p_body is null or length(trim(p_body)) not between 1 and 4000 then raise exception 'message must be 1-4000 characters'; end if;
 if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;
 v_hash:=encode(digest(trim(p_body),'sha256'),'hex'); select * into v_conversation from support_conversations where id=p_conversation_id for update;
 if not found then raise exception 'conversation not found'; end if; if v_conversation.customer_id<>p_customer_id then raise exception 'conversation access denied'; end if; if v_conversation.status='closed' then raise exception 'conversation is closed'; end if;
 select id,conversation_id,request_hash into v_existing from support_messages where sender_id=p_customer_id and idempotency_key=p_idempotency_key limit 1;
 if found then if v_existing.conversation_id is distinct from p_conversation_id then raise exception 'idempotency key belongs to another conversation'; end if; if v_existing.request_hash<>v_hash then raise exception 'idempotency key reuse with different message'; end if; return jsonb_build_object('messageId',v_existing.id,'conversationId',v_existing.conversation_id,'existing',true); end if;
 v_id:='msg_'||replace(gen_random_uuid()::text,'-',''); insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key,request_hash) values(v_id,p_conversation_id,p_customer_id,'customer',left(trim(p_body),4000),p_idempotency_key,v_hash);
 update support_conversations set status='waiting_support',updated_at=now() where id=p_conversation_id; return jsonb_build_object('messageId',v_id,'conversationId',p_conversation_id,'existing',false);
end $$;

create or replace function append_support_agent_message(p_support_id text,p_conversation_id text,p_body text,p_idempotency_key text) returns jsonb language plpgsql as $$
declare v_conversation record; v_id text; v_existing record; v_hash text; v_role text;
begin
 if current_setting('app.user_id',true) is distinct from p_support_id then raise exception 'unauthorized'; end if;
 select role into v_role from "user" where id=p_support_id; if v_role is distinct from 'admin' then raise exception 'support agent role required'; end if;
 if p_body is null or length(trim(p_body)) not between 1 and 4000 then raise exception 'message must be 1-4000 characters'; end if;
 if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;
 v_hash:=encode(digest(trim(p_body),'sha256'),'hex'); select * into v_conversation from support_conversations where id=p_conversation_id for update;
 if not found then raise exception 'conversation not found'; end if; if v_conversation.status='closed' then raise exception 'conversation is closed'; end if;
 if v_conversation.assigned_admin_id is not null and v_conversation.assigned_admin_id<>p_support_id then raise exception 'conversation is assigned to another admin'; end if;
 select id,conversation_id,request_hash into v_existing from support_messages where sender_id=p_support_id and idempotency_key=p_idempotency_key limit 1;
 if found then if v_existing.conversation_id is distinct from p_conversation_id then raise exception 'idempotency key belongs to another conversation'; end if; if v_existing.request_hash<>v_hash then raise exception 'idempotency key reuse with different message'; end if; return jsonb_build_object('messageId',v_existing.id,'conversationId',v_existing.conversation_id,'existing',true); end if;
 v_id:='msg_'||replace(gen_random_uuid()::text,'-',''); insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key,request_hash) values(v_id,p_conversation_id,p_support_id,'support',left(trim(p_body),4000),p_idempotency_key,v_hash);
 update support_conversations set status='waiting_customer',assigned_admin_id=coalesce(assigned_admin_id,p_support_id),updated_at=now() where id=p_conversation_id;
 perform record_audit_event('support.agent_message.sent','support_conversation',p_conversation_id,p_support_id,'admin',null,'success',jsonb_build_object('messageId',v_id,'orderId',v_conversation.order_id));
 return jsonb_build_object('messageId',v_id,'conversationId',p_conversation_id,'existing',false);
end $$;

create or replace function add_support_internal_note(p_admin_id text,p_conversation_id text,p_body text,p_idempotency_key text) returns jsonb language plpgsql as $$
declare v_role text; v_id text; v_hash text; v_existing record;
begin
 if current_setting('app.user_id',true) is distinct from p_admin_id then raise exception 'unauthorized'; end if; select role into v_role from "user" where id=p_admin_id; if v_role is distinct from 'admin' then raise exception 'admin role required'; end if;
 if p_body is null or length(trim(p_body)) not between 1 and 4000 then raise exception 'note must be 1-4000 characters'; end if; if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;
 v_hash:=encode(digest(trim(p_body),'sha256'),'hex'); perform 1 from support_conversations where id=p_conversation_id for update; if not found then raise exception 'conversation not found'; end if;
 select id,conversation_id,request_hash into v_existing from support_internal_notes where admin_id=p_admin_id and idempotency_key=p_idempotency_key limit 1;
 if found then if v_existing.conversation_id is distinct from p_conversation_id then raise exception 'idempotency key belongs to another conversation'; end if; if v_existing.request_hash<>v_hash then raise exception 'idempotency key reuse with different note'; end if; return jsonb_build_object('noteId',v_existing.id,'conversationId',v_existing.conversation_id,'existing',true); end if;
 v_id:='snote_'||replace(gen_random_uuid()::text,'-',''); insert into support_internal_notes(id,conversation_id,admin_id,body,idempotency_key,request_hash) values(v_id,p_conversation_id,p_admin_id,left(trim(p_body),4000),p_idempotency_key,v_hash);
 perform record_audit_event('support.internal_note.added','support_conversation',p_conversation_id,p_admin_id,'admin',null,'success',jsonb_build_object('noteId',v_id)); return jsonb_build_object('noteId',v_id,'conversationId',p_conversation_id,'existing',false);
end $$;

create or replace function update_support_conversation_state(p_admin_id text,p_conversation_id text,p_action text,p_priority text default null) returns jsonb language plpgsql as $$
declare v_role text; v record;
begin
 if current_setting('app.user_id',true) is distinct from p_admin_id then raise exception 'unauthorized'; end if; select role into v_role from "user" where id=p_admin_id; if v_role is distinct from 'admin' then raise exception 'admin role required'; end if;
 select * into v from support_conversations where id=p_conversation_id for update; if not found then raise exception 'conversation not found'; end if;
 if p_action='claim' then if v.status='closed' then raise exception 'closed conversation is terminal'; end if; if v.assigned_admin_id is not null and v.assigned_admin_id<>p_admin_id then raise exception 'conversation already claimed'; end if; update support_conversations set assigned_admin_id=p_admin_id,updated_at=now() where id=p_conversation_id;
 elsif p_action='unclaim' then if v.assigned_admin_id is distinct from p_admin_id then raise exception 'conversation is not claimed by this admin'; end if; update support_conversations set assigned_admin_id=null,updated_at=now() where id=p_conversation_id;
 elsif p_action='resolve' then if v.status='closed' then raise exception 'closed conversation is terminal'; end if; if v.assigned_admin_id is not null and v.assigned_admin_id<>p_admin_id then raise exception 'conversation is assigned to another admin'; end if; update support_conversations set status='resolved',assigned_admin_id=coalesce(assigned_admin_id,p_admin_id),updated_at=now() where id=p_conversation_id;
 elsif p_action='reopen' then if v.assigned_admin_id is not null and v.assigned_admin_id<>p_admin_id then raise exception 'conversation is assigned to another admin'; end if; if v.status<>'resolved' then raise exception 'only resolved conversations may be reopened'; end if; update support_conversations set status='waiting_support',assigned_admin_id=coalesce(assigned_admin_id,p_admin_id),updated_at=now() where id=p_conversation_id;
 elsif p_action='close' then if v.status='closed' then raise exception 'conversation already closed'; end if; if v.assigned_admin_id is not null and v.assigned_admin_id<>p_admin_id then raise exception 'conversation is assigned to another admin'; end if; update support_conversations set status='closed',assigned_admin_id=coalesce(assigned_admin_id,p_admin_id),updated_at=now() where id=p_conversation_id;
 elsif p_action='set_priority' then if v.status='closed' then raise exception 'closed conversation is terminal'; end if; if p_priority is null or p_priority not in ('low','normal','high','urgent') then raise exception 'invalid support priority'; end if; update support_conversations set priority=p_priority,updated_at=now() where id=p_conversation_id;
 else raise exception 'invalid support action'; end if;
 perform record_audit_event('support.conversation.'||p_action,'support_conversation',p_conversation_id,p_admin_id,'admin',null,'success',jsonb_strip_nulls(jsonb_build_object('previousStatus',v.status,'priority',p_priority)));
 return (select jsonb_build_object('conversationId',id,'status',status,'priority',priority,'assignedAdminId',assigned_admin_id) from support_conversations where id=p_conversation_id);
end $$;

create or replace function create_assisted_order_draft(
  p_support_id text,
  p_conversation_id text,
  p_items jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_conversation record; v_item record; v_product record; v_customer text; v_merchant text;
  v_first_merchant text; v_id text; v_items jsonb := '[]'::jsonb; v_role text;
begin
  if current_setting('app.user_id', true) is distinct from p_support_id then raise exception 'unauthorized'; end if;
  select role into v_role from "user" where id=p_support_id;
  if v_role is distinct from 'admin' then raise exception 'support agent role required'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>40 then raise exception 'invalid assisted order items'; end if;
  select * into v_conversation from support_conversations where id=p_conversation_id for update;
  if not found or v_conversation.status='closed' then raise exception 'conversation unavailable'; end if;
  if v_conversation.assigned_admin_id is not null and v_conversation.assigned_admin_id<>p_support_id then raise exception 'conversation is assigned to another admin'; end if;
  update support_order_drafts set status='expired',updated_at=now() where conversation_id=p_conversation_id and status='pending' and expires_at<=now();
  v_customer:=v_conversation.customer_id;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:assisted-order:'||p_conversation_id,0));
  if exists(select 1 from support_order_drafts where conversation_id=p_conversation_id and status in ('pending','checkout_started')) then raise exception 'an assisted order is already active for this conversation'; end if;
  for v_item in select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,(elem->>'quantity')::int as quantity from jsonb_array_elements(p_items) elem loop
    if v_item.product_id is null or v_item.product_id='' or v_item.quantity is null or v_item.quantity<1 or v_item.quantity>20 then raise exception 'invalid assisted order item'; end if;
    select p.id,p.merchant_id,p.name,p.price,p.stock,p.currency,p.status,m.status as merchant_status,m.verified into v_product from products p join merchants m on m.id=p.merchant_id where p.id=v_item.product_id for update of p;
    if not found or v_product.status<>'active' or v_product.merchant_status<>'active' or v_product.verified is not true then raise exception 'product is not currently orderable'; end if;
    v_merchant:=v_product.merchant_id;
    if v_first_merchant is null then v_first_merchant:=v_merchant; elsif v_first_merchant<>v_merchant then raise exception 'assisted order must contain one merchant'; end if;
    if v_item.variant_id is not null then perform 1 from product_variants pv where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active' and pv.stock>=v_item.quantity for update; if not found then raise exception 'variant is not currently available'; end if; elsif v_product.stock<v_item.quantity then raise exception 'product is not currently available'; end if;
    if v_product.currency<>'GHS' then raise exception 'unsupported currency'; end if;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('productId',v_item.product_id,'variantId',v_item.variant_id,'quantity',v_item.quantity));
  end loop;
  v_id:='aod_'||replace(gen_random_uuid()::text,'-','');
  insert into support_order_drafts(id,conversation_id,customer_id,created_by,items) values(v_id,p_conversation_id,v_customer,p_support_id,v_items);
  insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key,request_hash) values('msg_'||replace(gen_random_uuid()::text,'-',''),p_conversation_id,p_support_id,'support','I have prepared an order for you. Please review the order details in this chat and approve it before payment.','draft_'||v_id,encode(digest('I have prepared an order for you. Please review the order details in this chat and approve it before payment.','sha256'),'hex'));
  update support_conversations set updated_at=now(),status='waiting_customer' where id=p_conversation_id;
  perform record_audit_event('support.assisted_draft.created','support_conversation',p_conversation_id,p_support_id,'admin',null,'success',jsonb_build_object('draftId',v_id));
  return jsonb_build_object('draftId',v_id,'conversationId',p_conversation_id,'expiresAt',(select expires_at from support_order_drafts where id=v_id),'items',v_items);
end;
$$;

revoke all on function create_support_conversation(text,text) from public;

revoke all on function append_customer_support_message(text,text,text,text) from public;

revoke all on function append_support_agent_message(text,text,text,text) from public;

revoke all on function add_support_internal_note(text,text,text,text) from public;

revoke all on function update_support_conversation_state(text,text,text,text) from public;

revoke all on function create_assisted_order_draft(text,text,jsonb) from public;

revoke all on function get_assisted_order_draft(text,text) from public;
