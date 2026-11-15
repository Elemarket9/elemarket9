-- Support chat reliability.
--
-- 1. waiting_since: when the customer's oldest UNANSWERED message arrived. The
--    agent inbox used to sort by "last updated", so the customer who had waited
--    longest sank to the bottom. It now sorts longest-waiting first and shows
--    the wait.
-- 2. customer_last_read_at: lets the shop show an unread badge on the chat
--    button, so a customer learns that ELEMARKET replied without having to
--    reopen the chat to check.

alter table support_conversations add column if not exists waiting_since timestamptz;
alter table support_conversations add column if not exists customer_last_read_at timestamptz;

create or replace function support_track_waiting_since() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.sender_type = 'customer' then
    update support_conversations set waiting_since = coalesce(waiting_since, new.created_at) where id = new.conversation_id;
  elsif new.sender_type = 'support' then
    update support_conversations set waiting_since = null where id = new.conversation_id;
  end if;
  return new;
end $$;

drop trigger if exists support_message_waiting_since on support_messages;
create trigger support_message_waiting_since
  after insert on support_messages
  for each row execute function support_track_waiting_since();

-- Backfill: first customer message after the last support reply.
update support_conversations c
   set waiting_since = w.since
  from (
    select m.conversation_id, min(m.created_at) as since
      from support_messages m
     where m.sender_type = 'customer'
       and m.created_at > coalesce((select max(s.created_at) from support_messages s
                                     where s.conversation_id = m.conversation_id and s.sender_type = 'support'),
                                   '-infinity'::timestamptz)
     group by m.conversation_id
  ) w
 where w.conversation_id = c.id and c.waiting_since is null and c.status not in ('closed');

-- Existing threads start as read, so nobody sees a badge for old replies.
update support_conversations set customer_last_read_at = now() where customer_last_read_at is null;

create index if not exists support_conversations_waiting_idx
  on support_conversations (waiting_since) where waiting_since is not null;

create or replace function mark_support_conversation_read(p_customer_id text, p_conversation_id text)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  if p_customer_id is null or p_customer_id is distinct from nullif(current_setting('app.user_id', true), '') then
    raise exception 'unauthorized';
  end if;
  update support_conversations set customer_last_read_at = now()
   where id = p_conversation_id and customer_id = p_customer_id;
end $$;
revoke all on function mark_support_conversation_read(text, text) from public;

create or replace function support_unread_count(p_customer_id text)
returns integer language sql stable set search_path = public, pg_temp as $$
  select count(*)::int
    from support_messages m
    join support_conversations c on c.id = m.conversation_id
   where c.customer_id = p_customer_id
     and c.status <> 'closed'
     and m.sender_type = 'support'
     and m.created_at > coalesce(c.customer_last_read_at, '-infinity'::timestamptz);
$$;
revoke all on function support_unread_count(text) from public;
