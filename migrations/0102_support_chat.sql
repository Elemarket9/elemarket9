-- v1.72: ELEMARKET support chat.
-- Customer-facing support only; merchants are never direct chat participants.
-- Chat is informational/operational and cannot mutate order/payment state.

create table if not exists support_conversations (
  id text primary key,
  customer_id text not null references "user"(id) on delete restrict,
  order_id text references orders(id) on delete restrict,
  status text not null default 'open' check (status in ('open','waiting_customer','waiting_support','resolved','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_conversations_customer_updated_idx
  on support_conversations(customer_id, updated_at desc);
create index if not exists support_conversations_order_updated_idx
  on support_conversations(order_id, updated_at desc)
  where order_id is not null;
create unique index if not exists support_conversations_customer_order_open_uq
  on support_conversations(customer_id, order_id)
  where status in ('open','waiting_customer','waiting_support') and order_id is not null;
create unique index if not exists support_conversations_customer_general_open_uq
  on support_conversations(customer_id)
  where status in ('open','waiting_customer','waiting_support') and order_id is null;

create table if not exists support_messages (
  id text primary key,
  conversation_id text not null references support_conversations(id) on delete cascade,
  sender_id text not null references "user"(id) on delete restrict,
  sender_type text not null check (sender_type in ('customer','support')),
  body text not null check (char_length(trim(body)) between 1 and 4000),
  idempotency_key text not null check (char_length(trim(idempotency_key)) between 16 and 128),
  created_at timestamptz not null default now()
);

create unique index if not exists support_messages_sender_idempotency_uq
  on support_messages(sender_id, idempotency_key);
create index if not exists support_messages_conversation_created_idx
  on support_messages(conversation_id, created_at asc, id asc);

create or replace function create_support_conversation(
  p_customer_id text,
  p_order_id text default null
) returns text
language plpgsql
as $$
declare
  v_id text;
  v_owner text;
begin
  if p_customer_id is null or length(trim(p_customer_id)) < 1 then raise exception 'customer identity required'; end if;

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
   limit 1
   for update;

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
begin
  if p_customer_id is null then raise exception 'customer identity required'; end if;
  if p_body is null or length(trim(p_body)) < 1 or length(trim(p_body)) > 4000 then raise exception 'message must be 1-4000 characters'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 16 or length(trim(p_idempotency_key)) > 128 then raise exception 'invalid idempotency key'; end if;

  select * into v_conversation
    from support_conversations
   where id=p_conversation_id
   for update;
  if not found then raise exception 'conversation not found'; end if;
  if v_conversation.customer_id <> p_customer_id then raise exception 'conversation access denied'; end if;
  if v_conversation.status in ('resolved','closed') then raise exception 'conversation is closed'; end if;

  select id,conversation_id into v_existing
    from support_messages
   where sender_id=p_customer_id and idempotency_key=p_idempotency_key
   limit 1;
  if found then
    return jsonb_build_object('messageId',v_existing.id,'conversationId',v_existing.conversation_id,'existing',true);
  end if;

  v_id := 'msg_'||replace(gen_random_uuid()::text,'-','');
  insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key)
  values(v_id,p_conversation_id,p_customer_id,'customer',left(trim(p_body),4000),p_idempotency_key);
  update support_conversations set status='waiting_support',updated_at=now() where id=p_conversation_id;
  return jsonb_build_object('messageId',v_id,'conversationId',p_conversation_id,'existing',false);
end;
$$;

comment on table support_conversations is 'ELEMARKET customer-to-support conversations. No direct merchant chat.';
comment on table support_messages is 'Durable customer/support messages. Messages cannot mutate commerce state.';
