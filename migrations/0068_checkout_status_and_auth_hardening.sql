-- Checkout must never sell unpublished/suspended/archived products.
-- Recreate the current function body by text substitution at deployment time is unsafe,
-- therefore this migration uses a trigger-level database invariant.
create or replace function enforce_order_item_product_active() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from products p where p.id=new.product_id and p.status='active') then raise exception 'product is not available for purchase'; end if;
  return new;
end; $$;
drop trigger if exists order_item_product_active_guard on order_items;
create trigger order_item_product_active_guard before insert or update on order_items for each row execute function enforce_order_item_product_active();

-- Once a provider reference exists, cancellation cannot release inventory while an
-- external authorization is in flight. This closes pay-then-cancel double-spend races.
create or replace function release_order_stock(p_order_id text, p_user_id text)
returns void language plpgsql as $$
declare r record; v_payment record; v_claimed_user text:=current_setting('app.user_id',true);
begin
  if v_claimed_user is null or v_claimed_user<>p_user_id then raise exception 'unauthorized'; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:'||p_order_id,0));
  if not exists(select 1 from orders where id=p_order_id and user_id=p_user_id and status='payment_pending') then raise exception 'order is not cancellable'; end if;
  select * into v_payment from payments where order_id=p_order_id order by created_at desc limit 1 for update;
  if not found then raise exception 'payment not found'; end if;
  if v_payment.status<>'initiated' or v_payment.provider_reference is not null then raise exception 'payment is already with the provider; cancellation is blocked until payment settles or fails'; end if;
  for r in select * from order_stock_reservations where order_id=p_order_id and status='reserved' order by id for update loop
    if r.variant_id is not null then update product_variants set stock=stock+r.quantity,updated_at=now() where id=r.variant_id; else update products set stock=stock+r.quantity,updated_at=now() where id=r.product_id; end if;
    update order_stock_reservations set status='released',released_at=now() where id=r.id and status='reserved';
  end loop;
  update orders set status='cancelled',updated_at=now() where id=p_order_id and status='payment_pending';
end; $$;
