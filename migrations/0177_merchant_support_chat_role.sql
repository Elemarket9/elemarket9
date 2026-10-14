-- Forward-only authorization expansion for legacy merchant-role accounts.
-- Merchant dashboards embed general customer-support chat. A user with a
-- historical base role of merchant must be able to open their own conversation.
-- Preserve the actor-binding, strict conversation-owner, order-owner and
-- idempotency checks from 0176 without broadening admin/provider privileges.
-- The 'customer_id' column references users, not only customer-role accounts.
create or replace function create_support_conversation(p_customer_id text,p_order_id text default null) returns text language plpgsql as $$
declare v_id text; v_owner text; v_role text; v_lock text;
begin
 if p_customer_id is null or length(trim(p_customer_id))<1 then raise exception 'customer identity required'; end if;
 if current_setting('app.user_id',true) is distinct from p_customer_id then raise exception 'unauthorized'; end if;
 select role into v_role from "user" where id=p_customer_id; if v_role is distinct from 'customer' and v_role is distinct from 'merchant' then raise exception 'customer or merchant role required'; end if;
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
 select role into v_role from "user" where id=p_customer_id; if v_role is distinct from 'customer' and v_role is distinct from 'merchant' then raise exception 'customer or merchant role required'; end if;
 if p_body is null or length(trim(p_body)) not between 1 and 4000 then raise exception 'message must be 1-4000 characters'; end if;
 if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;
 v_hash:=encode(digest(trim(p_body),'sha256'),'hex'); select * into v_conversation from support_conversations where id=p_conversation_id for update;
 if not found then raise exception 'conversation not found'; end if; if v_conversation.customer_id<>p_customer_id then raise exception 'conversation access denied'; end if; if v_conversation.status='closed' then raise exception 'conversation is closed'; end if;
 select id,conversation_id,request_hash into v_existing from support_messages where sender_id=p_customer_id and idempotency_key=p_idempotency_key limit 1;
 if found then if v_existing.conversation_id is distinct from p_conversation_id then raise exception 'idempotency key belongs to another conversation'; end if; if v_existing.request_hash<>v_hash then raise exception 'idempotency key reuse with different message'; end if; return jsonb_build_object('messageId',v_existing.id,'conversationId',v_existing.conversation_id,'existing',true); end if;
 v_id:='msg_'||replace(gen_random_uuid()::text,'-',''); insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key,request_hash) values(v_id,p_conversation_id,p_customer_id,'customer',left(trim(p_body),4000),p_idempotency_key,v_hash);
 update support_conversations set status='waiting_support',updated_at=now() where id=p_conversation_id; return jsonb_build_object('messageId',v_id,'conversationId',p_conversation_id,'existing',false);
end $$;

revoke all on function create_support_conversation(text,text) from public;
revoke all on function append_customer_support_message(text,text,text,text) from public;
