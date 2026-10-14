-- Deep attack hardening: close the external-provider initialization cancellation race.
-- A payment attempt is created before the provider call; cancellation must not
-- release stock while that attempt is still open, even if provider_reference is null.
create or replace function release_order_stock(p_order_id text, p_user_id text)
returns void language plpgsql as $$
declare r record; v_payment record; v_open_attempt integer; v_claimed_user text:=current_setting('app.user_id',true);
begin
  if v_claimed_user is null or v_claimed_user<>p_user_id then raise exception 'unauthorized'; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:'||p_order_id,0));
  if not exists(select 1 from orders where id=p_order_id and user_id=p_user_id and status='payment_pending') then raise exception 'order is not cancellable'; end if;
  select * into v_payment from payments where order_id=p_order_id order by created_at desc limit 1 for update;
  if not found then raise exception 'payment not found'; end if;
  select count(*) into v_open_attempt from payment_attempts where payment_id=v_payment.id and status in ('initiated','pending','authorized');
  if v_open_attempt > 0 then raise exception 'payment is already being initialized or processed; cancellation is blocked until payment settles or fails'; end if;
  if v_payment.status not in ('initiated','failed') then raise exception 'payment is already with the provider; cancellation is blocked until payment settles or fails'; end if;
  for r in select * from order_stock_reservations where order_id=p_order_id and status='reserved' order by id for update loop
    if r.variant_id is not null then update product_variants set stock=stock+r.quantity,updated_at=now() where id=r.variant_id; else update products set stock=stock+r.quantity,updated_at=now() where id=r.product_id; end if;
    update order_stock_reservations set status='released',released_at=now() where id=r.id and status='reserved';
  end loop;
  update orders set status='cancelled',updated_at=now() where id=p_order_id and status='payment_pending';
end; $$;

comment on function release_order_stock(text,text) is 'Cancellation is blocked whenever an open provider payment attempt exists, including pre-reference initialization, preventing pay-then-cancel double-spend races.';
