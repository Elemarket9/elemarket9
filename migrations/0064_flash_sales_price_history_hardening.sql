-- ELEMARKET flash-sale and pricing hardening.
-- Flash sales are automatic limited-time offers with atomic allocation.
-- Price history prevents a merchant from manufacturing a false reference price.

create table if not exists product_price_history (
  id bigserial primary key,
  product_id text not null references products(id) on delete cascade,
  price numeric(12,2) not null check (price > 0),
  currency char(3) not null default 'GHS' check (currency='GHS'),
  effective_at timestamptz not null default now(),
  changed_at timestamptz not null default now()
);
create index if not exists product_price_history_lookup_idx
  on product_price_history(product_id,effective_at desc);

create table if not exists variant_price_history (
  id bigserial primary key,
  variant_id text not null references product_variants(id) on delete cascade,
  product_id text not null references products(id) on delete cascade,
  price numeric(12,2) not null check (price > 0),
  currency char(3) not null default 'GHS' check (currency='GHS'),
  effective_at timestamptz not null default now(),
  changed_at timestamptz not null default now()
);
create index if not exists variant_price_history_lookup_idx
  on variant_price_history(variant_id,effective_at desc);

insert into product_price_history(product_id,price,effective_at)
select p.id,p.price,coalesce(p.created_at,now())
from products p
where not exists (select 1 from product_price_history h where h.product_id=p.id);

insert into variant_price_history(variant_id,product_id,price,effective_at)
select pv.id,pv.product_id,pv.price,coalesce(pv.created_at,now())
from product_variants pv
where not exists (select 1 from variant_price_history h where h.variant_id=pv.id);

create or replace function record_product_price_history()
returns trigger language plpgsql as $$
begin
  if tg_op='INSERT' or new.price is distinct from old.price then
    insert into product_price_history(product_id,price,currency,effective_at)
    values(new.id,new.price,new.currency,now());
  end if;
  return new;
end;
$$;

drop trigger if exists product_price_history_capture on products;
create trigger product_price_history_capture
after insert or update of price on products
for each row execute function record_product_price_history();

create or replace function record_variant_price_history()
returns trigger language plpgsql as $$
begin
  if tg_op='INSERT' or new.price is distinct from old.price then
    insert into variant_price_history(variant_id,product_id,price,currency,effective_at)
    values(new.id,new.product_id,'GHS',now());
  end if;
  return new;
end;
$$;

drop trigger if exists variant_price_history_capture on product_variants;
create trigger variant_price_history_capture
after insert or update of price on product_variants
for each row execute function record_variant_price_history();

-- Derive the flash-sale reference price from authoritative catalog history.
-- The lowest observed price in the preceding 7 days is used, preventing a
-- temporary price increase immediately before a sale from manufacturing the
-- appearance of a discount.
create or replace function validate_flash_sale_item()
returns trigger language plpgsql as $$
declare
  v_sale record;
  v_product record;
  v_variant record;
  v_current numeric(12,2);
  v_reference numeric(12,2);
  v_target_key text;
  v_overlap boolean;
begin
  select * into v_sale from flash_sales where id=new.flash_sale_id for update;
  if not found then raise exception 'flash sale not found'; end if;

  if new.variant_id is not null then
    select pv.*,p.merchant_id,p.currency as product_currency into v_variant
      from product_variants pv join products p on p.id=pv.product_id
     where pv.id=new.variant_id and pv.product_id=new.product_id and pv.status in ('active','draft');
    if not found then raise exception 'flash sale variant mismatch'; end if;
    if v_variant.merchant_id<>v_sale.merchant_id then raise exception 'flash sale merchant mismatch'; end if;
    v_current:=v_variant.price;
    select least(v_current,coalesce(min(h.price) filter (where h.effective_at >= now()-interval '7 days'),v_current))
      into v_reference from variant_price_history h where h.variant_id=new.variant_id;
    v_target_key:='variant:'||new.variant_id;
  else
    select p.* into v_product from products p where p.id=new.product_id and p.merchant_id=v_sale.merchant_id for update;
    if not found then raise exception 'flash sale product mismatch'; end if;
    v_current:=v_product.price;
    select least(v_current,coalesce(min(h.price) filter (where h.effective_at >= now()-interval '7 days'),v_current))
      into v_reference from product_price_history h where h.product_id=new.product_id;
    v_target_key:='product:'||new.product_id;
  end if;

  if new.sale_price>=v_current or new.sale_price>=coalesce(v_reference,v_current) then
    raise exception 'flash sale price must be below the authoritative 7-day reference price';
  end if;
  new.reference_price:=coalesce(v_reference,v_current);

  -- Prevent overlapping campaigns for the same SKU. The advisory lock closes
  -- the check-then-insert race when two admins create sales simultaneously.
  perform pg_advisory_xact_lock(hashtextextended('elemarket:flash-target:'||v_target_key,0));
  select exists(
    select 1
      from flash_sale_items other
      join flash_sales os on os.id=other.flash_sale_id
     where other.id<>coalesce(new.id,0)
       and os.id<>new.flash_sale_id
       and os.status in ('scheduled','active','paused')
       and tstzrange(os.starts_at,os.ends_at,'[)') && tstzrange(v_sale.starts_at,v_sale.ends_at,'[)')
       and ((new.variant_id is not null and other.variant_id=new.variant_id)
         or (new.variant_id is null and other.variant_id is null and other.product_id=new.product_id))
  ) into v_overlap;
  if v_overlap then raise exception 'overlapping flash sale exists for this SKU'; end if;

  return new;
end;
$$;

drop trigger if exists flash_sale_item_integrity on flash_sale_items;
create trigger flash_sale_item_integrity
before insert or update on flash_sale_items
for each row execute function validate_flash_sale_item();

create or replace function validate_flash_sale_state()
returns trigger language plpgsql as $$
declare
  v_merchant record;
  v_items integer;
begin
  if new.status='active' then
    select status,verified into v_merchant from merchants where id=new.merchant_id for update;
    if not found or v_merchant.status<>'active' or v_merchant.verified is not true then
      raise exception 'flash sale merchant is not eligible';
    end if;
    if new.starts_at>now() or new.ends_at<=now() then
      raise exception 'flash sale is outside its active window';
    end if;
    select count(*) into v_items from flash_sale_items where flash_sale_id=new.id;
    if v_items<1 then raise exception 'flash sale requires at least one item'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists flash_sale_state_integrity on flash_sales;
create trigger flash_sale_state_integrity
before insert or update on flash_sales
for each row execute function validate_flash_sale_state();

-- Keep allocation counters and redemption state consistent with the order state.
create or replace function sync_flash_sale_after_order_status()
returns trigger language plpgsql as $$
declare
  r record;
  q record;
begin
  if old.status='payment_pending' and new.status='cancelled' then
    for q in
      select fsi.id,oi.quantity
        from flash_sale_redemptions fsr
        join flash_sale_items fsi on fsi.flash_sale_id=fsr.flash_sale_id
        join order_items oi on oi.order_id=new.id and oi.product_id=fsi.product_id
          and ((fsi.variant_id is not null and oi.variant_id=fsi.variant_id) or (fsi.variant_id is null and oi.variant_id is null))
       where fsr.order_id=new.id and fsr.status='reserved'
       for update of fsi
    loop
      update flash_sale_items
         set reserved_quantity=greatest(reserved_quantity-q.quantity,0),updated_at=now()
       where id=q.id;
    end loop;
    update flash_sale_redemptions
       set status='released',released_at=coalesce(released_at,now())
     where order_id=new.id and status='reserved';
  elsif old.status='payment_pending' and new.status in ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed') then
    for q in
      select fsi.id,oi.quantity
        from flash_sale_redemptions fsr
        join flash_sale_items fsi on fsi.flash_sale_id=fsr.flash_sale_id
        join order_items oi on oi.order_id=new.id and oi.product_id=fsi.product_id
          and ((fsi.variant_id is not null and oi.variant_id=fsi.variant_id) or (fsi.variant_id is null and oi.variant_id is null))
       where fsr.order_id=new.id and fsr.status='reserved'
       for update of fsi
    loop
      update flash_sale_items
         set reserved_quantity=greatest(reserved_quantity-q.quantity,0),
             sold_quantity=sold_quantity+q.quantity,updated_at=now()
       where id=q.id;
    end loop;
    update flash_sale_redemptions
       set status='consumed',consumed_at=coalesce(consumed_at,now())
     where order_id=new.id and status='reserved';
  end if;
  return new;
end;
$$;

drop trigger if exists flash_sale_order_status on orders;
create trigger flash_sale_order_status
after update of status on orders
for each row execute function sync_flash_sale_after_order_status();

create or replace function validate_flash_sale_redemption()
returns trigger language plpgsql as $$
declare
  v_order record;
  v_sale record;
begin
  select o.user_id,o.merchant_id,o.product_total,o.original_product_total,o.flash_sale_id
    into v_order from orders o where o.id=new.order_id;
  if not found then raise exception 'flash sale order not found'; end if;
  if v_order.flash_sale_id<>new.flash_sale_id then raise exception 'flash sale/order mismatch'; end if;
  if v_order.user_id<>new.user_id then raise exception 'flash sale/user mismatch'; end if;
  if round(v_order.original_product_total-v_order.product_total,2)<>round(new.discount_amount,2) then raise exception 'flash sale discount mismatch'; end if;
  select * into v_sale from flash_sales where id=new.flash_sale_id;
  if not found or v_sale.merchant_id<>v_order.merchant_id then raise exception 'flash sale merchant mismatch'; end if;
  return new;
end;
$$;

drop trigger if exists flash_sale_redemption_integrity on flash_sale_redemptions;
create trigger flash_sale_redemption_integrity
before insert or update on flash_sale_redemptions
for each row execute function validate_flash_sale_redemption();

-- An order can use either a coupon promotion or a flash sale, never both.
create or replace function validate_order_discount_exclusivity()
returns trigger language plpgsql as $$
begin
  if new.promo_id is not null and new.flash_sale_id is not null then
    raise exception 'order cannot combine promotion and flash sale';
  end if;
  return new;
end;
$$;

drop trigger if exists order_discount_exclusivity on orders;
create trigger order_discount_exclusivity
before insert or update of promo_id,flash_sale_id on orders
for each row execute function validate_order_discount_exclusivity();
