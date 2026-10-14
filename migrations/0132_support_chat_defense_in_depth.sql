-- v1.99.4: production support operations and defense-in-depth authorization.
alter table support_conversations add column if not exists priority text not null default 'normal' check (priority in ('low','normal','high','urgent'));
alter table support_conversations add column if not exists assigned_admin_id text references "user"(id) on delete set null;
create index if not exists support_conversations_active_priority_idx on support_conversations(status,priority,updated_at desc) where status in ('open','waiting_customer','waiting_support','resolved');
create index if not exists support_conversations_assignee_idx on support_conversations(assigned_admin_id,status,updated_at desc) where assigned_admin_id is not null;

create table if not exists support_internal_notes(
 id text primary key, conversation_id text not null references support_conversations(id) on delete cascade,
 admin_id text not null references "user"(id) on delete restrict, body text not null check(char_length(trim(body)) between 1 and 4000),
 idempotency_key text not null check(char_length(trim(idempotency_key)) between 16 and 128), request_hash text not null, created_at timestamptz not null default now()
);
create unique index if not exists support_internal_notes_admin_idempotency_uq on support_internal_notes(admin_id,idempotency_key);
create index if not exists support_internal_notes_conversation_created_idx on support_internal_notes(conversation_id,created_at,id);

create or replace function create_support_conversation(p_customer_id text,p_order_id text default null) returns text language plpgsql as $$
declare v_id text; v_owner text; v_role text; v_lock text;
begin
 if p_customer_id is null or length(trim(p_customer_id))<1 then raise exception 'customer identity required'; end if;
 if current_setting('app.user_id',true) is distinct from p_customer_id then raise exception 'unauthorized'; end if;
 select role into v_role from "user" where id=p_customer_id; if v_role<>'customer' then raise exception 'customer role required'; end if;
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
 select role into v_role from "user" where id=p_customer_id; if v_role<>'customer' then raise exception 'customer role required'; end if;
 if p_body is null or length(trim(p_body)) not between 1 and 4000 then raise exception 'message must be 1-4000 characters'; end if;
 if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;
 v_hash:=encode(digest(trim(p_body),'sha256'),'hex'); select * into v_conversation from support_conversations where id=p_conversation_id for update;
 if not found then raise exception 'conversation not found'; end if; if v_conversation.customer_id<>p_customer_id then raise exception 'conversation access denied'; end if; if v_conversation.status='closed' then raise exception 'conversation is closed'; end if;
 select id,conversation_id,request_hash into v_existing from support_messages where sender_id=p_customer_id and idempotency_key=p_idempotency_key limit 1;
 if found then if v_existing.request_hash<>v_hash then raise exception 'idempotency key reuse with different message'; end if; return jsonb_build_object('messageId',v_existing.id,'conversationId',v_existing.conversation_id,'existing',true); end if;
 v_id:='msg_'||replace(gen_random_uuid()::text,'-',''); insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key,request_hash) values(v_id,p_conversation_id,p_customer_id,'customer',left(trim(p_body),4000),p_idempotency_key,v_hash);
 update support_conversations set status='waiting_support',updated_at=now() where id=p_conversation_id; return jsonb_build_object('messageId',v_id,'conversationId',p_conversation_id,'existing',false);
end $$;

create or replace function append_support_agent_message(p_support_id text,p_conversation_id text,p_body text,p_idempotency_key text) returns jsonb language plpgsql as $$
declare v_conversation record; v_id text; v_existing record; v_hash text; v_role text;
begin
 if current_setting('app.user_id',true) is distinct from p_support_id then raise exception 'unauthorized'; end if;
 select role into v_role from "user" where id=p_support_id; if v_role<>'admin' then raise exception 'support agent role required'; end if;
 if p_body is null or length(trim(p_body)) not between 1 and 4000 then raise exception 'message must be 1-4000 characters'; end if;
 if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;
 v_hash:=encode(digest(trim(p_body),'sha256'),'hex'); select * into v_conversation from support_conversations where id=p_conversation_id for update;
 if not found then raise exception 'conversation not found'; end if; if v_conversation.status='closed' then raise exception 'conversation is closed'; end if;
 if v_conversation.assigned_admin_id is not null and v_conversation.assigned_admin_id<>p_support_id then raise exception 'conversation is assigned to another admin'; end if;
 select id,conversation_id,request_hash into v_existing from support_messages where sender_id=p_support_id and idempotency_key=p_idempotency_key limit 1;
 if found then if v_existing.request_hash<>v_hash then raise exception 'idempotency key reuse with different message'; end if; return jsonb_build_object('messageId',v_existing.id,'conversationId',v_existing.conversation_id,'existing',true); end if;
 v_id:='msg_'||replace(gen_random_uuid()::text,'-',''); insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key,request_hash) values(v_id,p_conversation_id,p_support_id,'support',left(trim(p_body),4000),p_idempotency_key,v_hash);
 update support_conversations set status='waiting_customer',assigned_admin_id=coalesce(assigned_admin_id,p_support_id),updated_at=now() where id=p_conversation_id;
 perform record_audit_event('support.agent_message.sent','support_conversation',p_conversation_id,p_support_id,'admin',null,'success',jsonb_build_object('messageId',v_id,'orderId',v_conversation.order_id));
 return jsonb_build_object('messageId',v_id,'conversationId',p_conversation_id,'existing',false);
end $$;

create or replace function add_support_internal_note(p_admin_id text,p_conversation_id text,p_body text,p_idempotency_key text) returns jsonb language plpgsql as $$
declare v_role text; v_id text; v_hash text; v_existing record;
begin
 if current_setting('app.user_id',true) is distinct from p_admin_id then raise exception 'unauthorized'; end if; select role into v_role from "user" where id=p_admin_id; if v_role<>'admin' then raise exception 'admin role required'; end if;
 if p_body is null or length(trim(p_body)) not between 1 and 4000 then raise exception 'note must be 1-4000 characters'; end if; if p_idempotency_key is null or length(trim(p_idempotency_key)) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;
 v_hash:=encode(digest(trim(p_body),'sha256'),'hex'); perform 1 from support_conversations where id=p_conversation_id for update; if not found then raise exception 'conversation not found'; end if;
 select id,conversation_id,request_hash into v_existing from support_internal_notes where admin_id=p_admin_id and idempotency_key=p_idempotency_key limit 1;
 if found then if v_existing.request_hash<>v_hash then raise exception 'idempotency key reuse with different note'; end if; return jsonb_build_object('noteId',v_existing.id,'conversationId',v_existing.conversation_id,'existing',true); end if;
 v_id:='snote_'||replace(gen_random_uuid()::text,'-',''); insert into support_internal_notes(id,conversation_id,admin_id,body,idempotency_key,request_hash) values(v_id,p_conversation_id,p_admin_id,left(trim(p_body),4000),p_idempotency_key,v_hash);
 perform record_audit_event('support.internal_note.added','support_conversation',p_conversation_id,p_admin_id,'admin',null,'success',jsonb_build_object('noteId',v_id)); return jsonb_build_object('noteId',v_id,'conversationId',p_conversation_id,'existing',false);
end $$;

create or replace function update_support_conversation_state(p_admin_id text,p_conversation_id text,p_action text,p_priority text default null) returns jsonb language plpgsql as $$
declare v_role text; v record;
begin
 if current_setting('app.user_id',true) is distinct from p_admin_id then raise exception 'unauthorized'; end if; select role into v_role from "user" where id=p_admin_id; if v_role<>'admin' then raise exception 'admin role required'; end if;
 select * into v from support_conversations where id=p_conversation_id for update; if not found then raise exception 'conversation not found'; end if;
 if p_action='claim' then if v.status='closed' then raise exception 'closed conversation is terminal'; end if; if v.assigned_admin_id is not null and v.assigned_admin_id<>p_admin_id then raise exception 'conversation already claimed'; end if; update support_conversations set assigned_admin_id=p_admin_id,updated_at=now() where id=p_conversation_id;
 elsif p_action='unclaim' then if v.assigned_admin_id is distinct from p_admin_id then raise exception 'conversation is not claimed by this admin'; end if; update support_conversations set assigned_admin_id=null,updated_at=now() where id=p_conversation_id;
 elsif p_action='resolve' then if v.status='closed' then raise exception 'closed conversation is terminal'; end if; if v.assigned_admin_id is not null and v.assigned_admin_id<>p_admin_id then raise exception 'conversation is assigned to another admin'; end if; update support_conversations set status='resolved',assigned_admin_id=coalesce(assigned_admin_id,p_admin_id),updated_at=now() where id=p_conversation_id;
 elsif p_action='reopen' then if v.status<>'resolved' then raise exception 'only resolved conversations may be reopened'; end if; update support_conversations set status='waiting_support',assigned_admin_id=coalesce(assigned_admin_id,p_admin_id),updated_at=now() where id=p_conversation_id;
 elsif p_action='close' then if v.status='closed' then raise exception 'conversation already closed'; end if; if v.assigned_admin_id is not null and v.assigned_admin_id<>p_admin_id then raise exception 'conversation is assigned to another admin'; end if; update support_conversations set status='closed',assigned_admin_id=coalesce(assigned_admin_id,p_admin_id),updated_at=now() where id=p_conversation_id;
 elsif p_action='set_priority' then if v.status='closed' then raise exception 'closed conversation is terminal'; end if; if p_priority not in ('low','normal','high','urgent') then raise exception 'invalid support priority'; end if; update support_conversations set priority=p_priority,updated_at=now() where id=p_conversation_id;
 else raise exception 'invalid support action'; end if;
 perform record_audit_event('support.conversation.'||p_action,'support_conversation',p_conversation_id,p_admin_id,'admin',null,'success',jsonb_strip_nulls(jsonb_build_object('previousStatus',v.status,'priority',p_priority)));
 return (select jsonb_build_object('conversationId',id,'status',status,'priority',priority,'assignedAdminId',assigned_admin_id) from support_conversations where id=p_conversation_id);
end $$;

comment on table support_internal_notes is 'Admin-only operational notes. Customer APIs must never read this table.';
comment on function create_support_conversation(text,text) is 'Customer-only support conversation creation with actor binding and order ownership enforcement.';
comment on function add_support_internal_note(text,text,text,text) is 'Admin-only internal note stored separately from customer-visible messages.';
comment on function update_support_conversation_state(text,text,text,text) is 'Admin-only row-locked support queue state machine.';
