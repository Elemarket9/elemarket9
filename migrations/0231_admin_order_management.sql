-- Admin order management (back office).
--
-- 1. admin_order_notes: append-only internal notes on an order. Staff can add a
--    note; nobody (application or SQL console) can edit or delete one.
-- 2. add_admin_order_note(): writes the note and its audit event atomically.
-- 3. admin_cancel_unpaid_order(): the ONLY admin cancellation path. It mirrors
--    the customer path release_order_stock() exactly (same advisory lock, row
--    locks, open-attempt and payment-status guards, reservation release and
--    status guard) with an administrator as the actor. It refuses every order
--    that is not awaiting payment: paid orders are refunded through finance
--    (two-person approval), never cancelled here.
-- 4. Search indexes for the admin order search (newest first, order-ID suffix,
--    delivery contact phone, case-insensitive email, merchant name contains).

create table if not exists admin_order_notes (
  id text primary key,
  order_id text not null references orders(id) on delete restrict,
  admin_id text not null references "user"(id) on delete restrict,
  body text not null,
  created_at timestamptz not null default now(),
  constraint admin_order_notes_body_check check (body = btrim(body) and char_length(body) between 3 and 2000)
);
create index if not exists admin_order_notes_order_idx on admin_order_notes(order_id, created_at desc, id desc);

create or replace function reject_admin_order_note_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'admin_order_notes is append-only';
end;
$$;

drop trigger if exists admin_order_notes_no_update on admin_order_notes;
create trigger admin_order_notes_no_update before update on admin_order_notes
  for each row execute function reject_admin_order_note_mutation();
drop trigger if exists admin_order_notes_no_delete on admin_order_notes;
create trigger admin_order_notes_no_delete before delete on admin_order_notes
  for each row execute function reject_admin_order_note_mutation();
drop trigger if exists admin_order_notes_no_truncate on admin_order_notes;
create trigger admin_order_notes_no_truncate before truncate on admin_order_notes
  for each statement execute function reject_admin_order_note_mutation();

-- Shared actor check: the session identity must be this user, and the user must
-- be an active administrator. The exact permission is checked by the server.
create or replace function elemarket_require_active_admin(p_admin_id text) returns void
language plpgsql as $$
begin
  if p_admin_id is null or current_setting('app.user_id', true) is distinct from p_admin_id then
    raise exception 'unauthorized';
  end if;
  if not exists (
    select 1 from "user" u join admin_staff_roles s on s.user_id = u.id
     where u.id = p_admin_id and u.role = 'admin' and s.status = 'active'
  ) then
    raise exception 'admin role required';
  end if;
end;
$$;

create or replace function add_admin_order_note(p_admin_id text, p_order_id text, p_body text) returns jsonb
language plpgsql as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_id text;
begin
  perform elemarket_require_active_admin(p_admin_id);
  if char_length(v_body) not between 3 and 2000 then
    raise exception 'note must be 3-2000 characters';
  end if;
  perform 1 from orders where id = p_order_id for share;
  if not found then raise exception 'order not found'; end if;
  v_id := 'aonote_' || replace(gen_random_uuid()::text, '-', '');
  insert into admin_order_notes(id, order_id, admin_id, body) values (v_id, p_order_id, p_admin_id, v_body);
  perform record_audit_event('admin.order.note_added', 'order', p_order_id, p_admin_id, 'admin', null, 'success',
    jsonb_build_object('noteId', v_id, 'length', char_length(v_body)));
  return jsonb_build_object('noteId', v_id, 'orderId', p_order_id);
end;
$$;

create or replace function admin_cancel_unpaid_order(p_order_id text, p_admin_id text, p_reason text) returns jsonb
language plpgsql as $$
declare
  r record;
  v_payment record;
  v_order record;
  v_open_attempt integer;
  v_released integer := 0;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform elemarket_require_active_admin(p_admin_id);
  if char_length(v_reason) not between 12 and 1000 then
    raise exception 'cancellation reason must be 12-1000 characters';
  end if;

  -- Same lock as payment completion, expiry and the customer cancellation.
  perform pg_advisory_xact_lock(hashtextextended('elemarket:order:' || p_order_id, 0));

  select * into v_order from orders where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;

  -- Unlike the customer path (an idempotent no-op), an administrator must be
  -- told plainly that nothing happened.
  if v_order.status <> 'payment_pending' then
    raise exception 'only orders awaiting payment can be cancelled here; paid orders must be refunded through finance';
  end if;
  if exists (select 1 from payments where order_id = p_order_id and status in ('completed', 'authorized', 'refunded')) then
    raise exception 'order has a captured payment; request a refund through finance instead';
  end if;

  select * into v_payment from payments where order_id = p_order_id order by created_at desc limit 1 for update;
  if not found then raise exception 'payment not found'; end if;

  select count(*) into v_open_attempt from payment_attempts
   where payment_id = v_payment.id and status in ('initiated', 'pending', 'authorized');
  if v_open_attempt > 0 then
    raise exception 'payment is already being initialized or processed; cancellation is blocked until payment settles or fails';
  end if;
  if v_payment.status not in ('initiated', 'failed') then
    raise exception 'payment is already with the provider; cancellation is blocked until payment settles or fails';
  end if;

  for r in
    select * from order_stock_reservations
     where order_id = p_order_id and status = 'reserved'
     order by id
     for update
  loop
    if r.variant_id is not null then
      update product_variants set stock = stock + r.quantity, updated_at = now() where id = r.variant_id;
      if not found then raise exception 'reserved variant not found'; end if;
    else
      update products set stock = stock + r.quantity, updated_at = now() where id = r.product_id;
      if not found then raise exception 'reserved product not found'; end if;
    end if;
    update order_stock_reservations set status = 'released', released_at = now() where id = r.id and status = 'reserved';
    v_released := v_released + 1;
  end loop;

  update orders set status = 'cancelled', updated_at = now() where id = p_order_id and status = 'payment_pending';
  if not found then raise exception 'order changed during cancellation'; end if;

  perform record_audit_event('admin.order.cancelled', 'order', p_order_id, p_admin_id, 'admin', null, 'success',
    jsonb_build_object('reason', v_reason, 'previousStatus', 'payment_pending', 'releasedReservations', v_released));
  return jsonb_build_object('orderId', p_order_id, 'status', 'cancelled', 'releasedReservations', v_released);
end;
$$;

-- Search support. Each filter in the admin search can use an index.
create index if not exists orders_created_id_idx on orders(created_at desc, id desc);
create index if not exists orders_id_suffix_idx on orders((right(id, 8)));
create index if not exists orders_delivery_contact_phone_idx on orders(delivery_contact_phone) where delivery_contact_phone is not null;
create index if not exists user_email_lower_idx on "user"(lower(email));
-- pg_trgm is optional (embedded preview databases may not ship it); merchants
-- is a small table, so without it the name filter is a cheap sequential scan.
do $$
begin
  begin
    create extension if not exists pg_trgm;
    execute 'create index if not exists merchants_name_trgm_idx on merchants using gin (name gin_trgm_ops)';
  exception
    when others then
      raise notice 'pg_trgm unavailable; merchant name search scans merchants';
  end;
end $$;
