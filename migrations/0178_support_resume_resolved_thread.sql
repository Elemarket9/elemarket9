-- Continue the existing support thread after resolution rather than presenting
-- a blank chat and creating a second conversation when the customer returns.
-- Security checks and active-thread uniqueness behavior from 0177 are retained.
create or replace function create_support_conversation(p_customer_id text,p_order_id text default null) returns text language plpgsql as $$
declare v_id text; v_owner text; v_role text; v_lock text;
begin
 if p_customer_id is null or length(trim(p_customer_id))<1 then raise exception 'customer identity required'; end if;
 if current_setting('app.user_id',true) is distinct from p_customer_id then raise exception 'unauthorized'; end if;
 select role into v_role from "user" where id=p_customer_id;
 if v_role is distinct from 'customer' and v_role is distinct from 'merchant' then raise exception 'customer or merchant role required'; end if;
 v_lock:='elemarket:support-conversation:'||p_customer_id||':'||coalesce(p_order_id,'general');
 perform pg_advisory_xact_lock(hashtextextended(v_lock,0));
 if p_order_id is not null then
   select user_id into v_owner from orders where id=p_order_id for share;
   if not found then raise exception 'order not found'; end if;
   if v_owner<>p_customer_id then raise exception 'customer does not own order'; end if;
 end if;
 -- Prioritize an active thread. If none exists, let the customer reply to a
 -- resolved thread: append_customer_support_message moves it to waiting_support.
 -- Closed threads remain terminal and must not be reused.
 select id into v_id from support_conversations
  where customer_id=p_customer_id
    and ((p_order_id is null and order_id is null) or order_id=p_order_id)
    and status in ('open','waiting_customer','waiting_support','resolved')
  order by case when status='resolved' then 1 else 0 end,updated_at desc
  limit 1;
 if found then return v_id; end if;
 v_id:='sup_'||replace(gen_random_uuid()::text,'-','');
 insert into support_conversations(id,customer_id,order_id,status) values(v_id,p_customer_id,p_order_id,'open');
 return v_id;
end $$;
revoke all on function create_support_conversation(text,text) from public;
