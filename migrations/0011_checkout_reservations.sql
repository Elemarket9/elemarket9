-- Checkout reservation hardening.
-- Payment-pending orders reserve inventory. Cancellation/expiry releases it exactly once.

alter table orders add column if not exists payment_deadline timestamptz;

create table if not exists order_stock_reservations (
  id bigserial primary key,
  order_id text not null references orders(id) on delete cascade,
  order_item_id bigint not null references order_items(id) on delete cascade,
  product_id text not null references products(id),
  variant_id text references product_variants(id),
  quantity integer not null check (quantity > 0 and quantity <= 20),
  status text not null default 'reserved' check (status in ('reserved','released','consumed')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  unique (order_item_id)
);
create index if not exists order_stock_reservations_order_idx on order_stock_reservations(order_id, status);

-- The reservation deadline is intentionally short enough to avoid stranded stock.
-- Payment providers may later replace this with provider-specific expiry semantics.

create or replace function release_order_stock(p_order_id text, p_user_id text)
returns void
language plpgsql
as $$
declare
  v_claimed_user text := current_setting('app.user_id', true);
  r record;
begin
  if v_claimed_user is null or v_claimed_user <> p_user_id then raise exception 'unauthorized'; end if;
  perform pg_advisory_xact_lock(hashtext('elemarket:release:' || p_order_id));

  if not exists (select 1 from orders where id = p_order_id and user_id = p_user_id) then
    raise exception 'order not found';
  end if;

  for r in
    select * from order_stock_reservations where order_id = p_order_id and status = 'reserved' for update
  loop
    if r.variant_id is not null then
      update product_variants set stock = stock + r.quantity, updated_at = now() where id = r.variant_id;
    else
      update products set stock = stock + r.quantity where id = r.product_id;
    end if;
    update order_stock_reservations set status = 'released', released_at = now() where id = r.id;
  end loop;

  update orders set status = 'cancelled', updated_at = now() where id = p_order_id and status = 'payment_pending';
end;
$$;

-- Make payment-pending inventory reservation expiry explicit for operational workers.
create index if not exists orders_payment_deadline_idx
  on orders(payment_deadline)
  where status = 'payment_pending' and payment_deadline is not null;
