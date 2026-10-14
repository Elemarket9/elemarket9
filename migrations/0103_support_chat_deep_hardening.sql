-- v1.73: Support chat concurrency, idempotency, and authorization hardening.

-- pgcrypto provides digest(..., 'sha256') used below and by later migrations.
-- Keep this before the first digest call so a clean PostgreSQL database does not fail here.
create extension if not exists pgcrypto;

alter table support_messages
  add column if not exists request_hash text;

update support_messages
   set request_hash = encode(digest(trim(body), 'sha256'), 'hex')
 where request_hash is null;

alter table support_messages
  alter column request_hash set not null;

create index if not exists support_messages_request_hash_idx
  on support_messages(sender_id, idempotency_key, request_hash);

create or replace function create_support_conversation(
  p_customer_id text,
  p_order_id text default null
) returns text
language plpgsql
as $$
declare
  v_id text;
  v_owner text;
  v_lock_key text;
begin
  if p_customer_id is null or length(trim(p_customer_id)) < 1 then
    raise exception 'customer identity required';
  end if;

  v_lock_key := 'elemarket:support-conversation:' || p_customer_id || ':' || coalesce(p_order_id, 'general');
  perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

  if p_order_id is not null then
    select user_id into v_owner from orders where id=p_order_id for share;
    if not found then raise exception 'order not found'; end if;
    if v_owner <> p_customer_id then raise exception 'customer does not own order'; end if;
  end if;

  select id into v_id
    from support_conversations
   where customer_id=p_customer_id
     and ((p_order_id is null and order_id is null) or order_id=p_order_id)
     and status in ('open','waiting_customer','waiting_support')
   order by updated_at desc
   limit 1;

  if found then return v_id; end if;

  v_id := 'sup_'||replace(gen_random_uuid()::text,'-','');
  insert into support_conversations(id,customer_id,order_id,status)
  values(v_id,p_customer_id,p_order_id,'open');
  return v_id;
end;
$$;

create or replace function append_customer_support_message(
  p_customer_id text,
  p_conversation_id text,
  p_body text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_conversation record;
  v_id text;
  v_existing record;
  v_hash text;
begin
  if p_customer_id is null then raise exception 'customer identity required'; end if;
  if p_body is null or length(trim(p_body)) < 1 or length(trim(p_body)) > 4000 then raise exception 'message must be 1-4000 characters'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 16 or length(trim(p_idempotency_key)) > 128 then raise exception 'invalid idempotency key'; end if;
  v_hash := encode(digest(trim(p_body), 'sha256'), 'hex');

  select * into v_conversation
    from support_conversations
   where id=p_conversation_id
   for update;
  if not found then raise exception 'conversation not found'; end if;
  if v_conversation.customer_id <> p_customer_id then raise exception 'conversation access denied'; end if;
  if v_conversation.status in ('resolved','closed') then raise exception 'conversation is closed'; end if;

  select id,conversation_id,request_hash into v_existing
    from support_messages
   where sender_id=p_customer_id and idempotency_key=p_idempotency_key
   limit 1;
  if found then
    if v_existing.request_hash <> v_hash then raise exception 'idempotency key reuse with different message'; end if;
    return jsonb_build_object('messageId',v_existing.id,'conversationId',v_existing.conversation_id,'existing',true);
  end if;

  v_id := 'msg_'||replace(gen_random_uuid()::text,'-','');
  insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key,request_hash)
  values(v_id,p_conversation_id,p_customer_id,'customer',left(trim(p_body),4000),p_idempotency_key,v_hash);
  update support_conversations set status='waiting_support',updated_at=now() where id=p_conversation_id;
  return jsonb_build_object('messageId',v_id,'conversationId',p_conversation_id,'existing',false);
end;
$$;

create or replace function append_support_agent_message(
  p_support_id text,
  p_conversation_id text,
  p_body text,
  p_idempotency_key text
) returns jsonb
language plpgsql
as $$
declare
  v_conversation record;
  v_id text;
  v_existing record;
  v_hash text;
begin
  if p_support_id is null then raise exception 'support identity required'; end if;
  if p_body is null or length(trim(p_body)) < 1 or length(trim(p_body)) > 4000 then raise exception 'message must be 1-4000 characters'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 16 or length(trim(p_idempotency_key)) > 128 then raise exception 'invalid idempotency key'; end if;
  v_hash := encode(digest(trim(p_body), 'sha256'), 'hex');

  select * into v_conversation
    from support_conversations
   where id=p_conversation_id
   for update;
  if not found then raise exception 'conversation not found'; end if;
  if v_conversation.status='closed' then raise exception 'conversation is closed'; end if;

  select id,conversation_id,request_hash into v_existing
    from support_messages
   where sender_id=p_support_id and idempotency_key=p_idempotency_key
   limit 1;
  if found then
    if v_existing.request_hash <> v_hash then raise exception 'idempotency key reuse with different message'; end if;
    return jsonb_build_object('messageId',v_existing.id,'conversationId',v_existing.conversation_id,'existing',true);
  end if;

  v_id := 'msg_'||replace(gen_random_uuid()::text,'-','');
  insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key,request_hash)
  values(v_id,p_conversation_id,p_support_id,'support',left(trim(p_body),4000),p_idempotency_key,v_hash);
  update support_conversations set status='waiting_customer',updated_at=now() where id=p_conversation_id;
  return jsonb_build_object('messageId',v_id,'conversationId',p_conversation_id,'existing',false);
end;
$$;

comment on column support_messages.request_hash is 'SHA-256 fingerprint of normalized message body for safe idempotency-key reuse detection.';
