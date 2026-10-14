-- REWRITTEN 2026-10-13 with user authorization; NOT the historical bytes.
-- Later support migrations retain these write-boundary and audit controls.
create or replace function guard_support_message_actor()
returns trigger language plpgsql as $$
declare v_role text; v_customer text;
begin
  if current_setting('app.user_id',true) is distinct from new.sender_id then raise exception 'support message actor mismatch'; end if;
  select role into v_role from "user" where id=new.sender_id;
  select customer_id into v_customer from support_conversations where id=new.conversation_id;
  if new.sender_type='customer' then
    if v_role is distinct from 'customer' or v_customer is distinct from new.sender_id then raise exception 'support conversation access denied'; end if;
  elsif new.sender_type='support' then
    if v_role is distinct from 'admin' then raise exception 'support agent role required'; end if;
  else raise exception 'invalid support sender'; end if;
  return new;
end $$;
create trigger support_message_actor_guard before insert on support_messages
for each row execute function guard_support_message_actor();

create or replace function audit_support_message_insert()
returns trigger language plpgsql as $$
begin
  perform record_audit_event('support.message.created','support_conversation',new.conversation_id,new.sender_id,
    case when new.sender_type='support' then 'admin' else 'customer' end,null,'success',jsonb_build_object('messageId',new.id,'senderType',new.sender_type));
  return new;
end $$;
create trigger support_message_insert_audit after insert on support_messages
for each row execute function audit_support_message_insert();
revoke all on function create_support_conversation(text,text) from public;
revoke all on function append_customer_support_message(text,text,text,text) from public;
revoke all on function append_support_agent_message(text,text,text,text) from public;
revoke all on function create_assisted_order_draft(text,text,jsonb) from public;
revoke all on function get_assisted_order_draft(text,text) from public;
