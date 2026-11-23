-- 0234 Marketplace promotions run and funded by ELEMARKET, plus admin
-- oversight (pause/resume) of merchant promotions and flash sales.
--
-- Builds on the existing promotion engine (0063/0065/0112):
--   * promotions.merchant_id NULL already meant "global" promotion, and 0065's
--     participation model made those MERCHANT-funded (the discount lowers the
--     merchant's product_total and therefore merchant_net). That behaviour is
--     unchanged and remains the default (funding_source = 'merchant').
--   * funding_source = 'platform' is new: ELEMARKET pays the discount.
--   * promotion_budgets (0112) is reused as the hard budget boundary.
--
-- Money rules for funding_source = 'platform' (per merchant order):
--   D            = min(computed discount, max_discount, commission on the
--                  undiscounted basket of THIS order minus GHS 0.01)
--                  The one-pesewa margin keeps platform_fee > 0: the Paystack
--                  adapter omits transaction_charge when the fee is 0, and the
--                  provider would then apply the subaccount's DEFAULT split,
--                  changing what the merchant receives.
--   product_total = undiscounted basket - D      (what the customer pays for goods)
--   platform_fee  = commission on undiscounted basket - D   (never negative)
--   merchant_net  = undiscounted basket - commission         (UNCHANGED by the promotion)
--   grand_total   = product_total + delivery_total           (payment amount, refund basis)
-- All pre-existing invariants keep holding (grand_total = product_total +
-- delivery_total, original_product_total = product_total + promo_discount,
-- merchant_net = product_total - platform_fee), so the provider split
-- (transaction_charge = platform_fee), wallet sale credit (merchant_net) and
-- refunds (payments.amount) need no code changes.
--
-- Budget: redemptions reserve budget on insert (status 'reserved'), move it to
-- consumed when the order is paid/confirmed ('applied'), and release it when the
-- redemption is released (unpaid cancellation, payment-deadline expiry, refused
-- pay-on-delivery). Accounting follows promotion_redemptions.status in ONE
-- trigger, so every existing path that releases a redemption also releases budget.

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------
alter table promotions add column if not exists funding_source text not null default 'merchant';
alter table promotions drop constraint if exists promotions_funding_source_check;
alter table promotions add constraint promotions_funding_source_check check (funding_source in ('merchant','platform'));
-- A marketplace promotion belongs to no merchant and needs no merchant consent:
-- it never touches merchant earnings.
alter table promotions drop constraint if exists promotions_platform_shape_check;
alter table promotions add constraint promotions_platform_shape_check
  check (funding_source='merchant' or (merchant_id is null and participation_required=false));
alter table promotions add column if not exists is_public boolean not null default false;
alter table promotions add column if not exists description text;
alter table promotions drop constraint if exists promotions_description_check;
alter table promotions add constraint promotions_description_check check (description is null or char_length(description)<=500);
alter table promotions add column if not exists admin_paused_at timestamptz;
alter table promotions add column if not exists admin_paused_by text;
alter table promotions add column if not exists admin_pause_reason text;
-- An administrator's pause can only be lifted by clearing it (admin resume):
-- no other path can set the promotion back to active while it is held.
alter table promotions drop constraint if exists promotions_admin_pause_check;
alter table promotions add constraint promotions_admin_pause_check check (
  (admin_paused_at is null and admin_paused_by is null and admin_pause_reason is null)
  or (admin_paused_at is not null and admin_paused_by is not null
      and char_length(trim(admin_pause_reason)) between 5 and 500 and status='paused'));
create index if not exists promotions_funding_idx on promotions(funding_source,status,starts_at,ends_at);

alter table flash_sales add column if not exists admin_paused_at timestamptz;
alter table flash_sales add column if not exists admin_paused_by text;
alter table flash_sales add column if not exists admin_pause_reason text;
alter table flash_sales drop constraint if exists flash_sales_admin_pause_check;
alter table flash_sales add constraint flash_sales_admin_pause_check check (
  (admin_paused_at is null and admin_paused_by is null and admin_pause_reason is null)
  or (admin_paused_at is not null and admin_paused_by is not null
      and char_length(trim(admin_pause_reason)) between 5 and 500 and status='paused'));

-- Optional merchant scope for marketplace promotions (empty = every merchant).
create table if not exists promotion_merchants (
  promotion_id text not null references promotions(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  primary key (promotion_id, merchant_id)
);
create index if not exists promotion_merchants_merchant_idx on promotion_merchants(merchant_id);

-- How much of an order's promo_discount ELEMARKET paid for (0 for merchant promos).
alter table orders add column if not exists platform_funded_discount numeric(12,2) not null default 0;
alter table orders drop constraint if exists orders_platform_funded_discount_check;
alter table orders add constraint orders_platform_funded_discount_check check (
  platform_funded_discount >= 0
  and platform_funded_discount <= promo_discount
  and (platform_funded_discount = 0 or merchant_net = product_total - platform_fee));

-- ---------------------------------------------------------------------------
-- 2. Promotion definition rules
-- ---------------------------------------------------------------------------
create or replace function validate_promotion_definition()
returns trigger language plpgsql as $$
declare v_merchant record;
begin
  -- Merchant eligibility gates going live. Pausing or archiving a promotion of a
  -- suspended merchant must always be possible.
  if new.merchant_id is not null and (tg_op='INSERT' or new.status='active') then
    select status,verified into v_merchant from merchants where id=new.merchant_id;
    if not found or v_merchant.status<>'active' or v_merchant.verified is not true then
      raise exception 'promotion merchant is not eligible';
    end if;
  end if;
  if new.ends_at<=new.starts_at then raise exception 'invalid promotion window'; end if;
  if tg_op='UPDATE' and new.funding_source is distinct from old.funding_source then
    raise exception 'promotion funding source cannot change';
  end if;
  if new.funding_source='platform' then
    -- 'active' on a marketplace promotion means "approved to run in its window";
    -- checkout still enforces starts_at/ends_at. A started promotion keeps its
    -- money terms: only status, display text, end-date shortening and budget
    -- increases (promotion_budgets) may change.
    if tg_op='UPDATE' and old.starts_at<=now() and (
         new.code is distinct from old.code or
         new.discount_type is distinct from old.discount_type or
         new.discount_value is distinct from old.discount_value or
         new.max_discount is distinct from old.max_discount or
         new.min_subtotal is distinct from old.min_subtotal or
         new.usage_limit is distinct from old.usage_limit or
         new.per_customer_limit is distinct from old.per_customer_limit or
         new.first_order_only is distinct from old.first_order_only or
         new.new_customer_only is distinct from old.new_customer_only or
         new.currency is distinct from old.currency or
         new.starts_at is distinct from old.starts_at or
         new.merchant_id is distinct from old.merchant_id or
         new.ends_at > old.ends_at
       ) then
      raise exception 'a started marketplace promotion can only be paused, resumed, shortened or given more budget';
    end if;
  else
    if new.status='active' and new.starts_at>now() then raise exception 'active promotion cannot start in the future'; end if;
    if new.status='active' and new.ends_at<=now() then raise exception 'active promotion has expired'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists promotion_definition_integrity on promotions;
create trigger promotion_definition_integrity
before insert or update on promotions
for each row execute function validate_promotion_definition();

-- Scope of a started marketplace promotion is frozen too.
create or replace function guard_started_platform_promotion_scope()
returns trigger language plpgsql as $$
declare v_promo record; v_id text;
begin
  v_id := case when tg_op='DELETE' then old.promotion_id else new.promotion_id end;
  select funding_source,starts_at into v_promo from promotions where id=v_id;
  if found and v_promo.funding_source='platform' and v_promo.starts_at<=now() then
    raise exception 'a started marketplace promotion can only be paused, resumed, shortened or given more budget';
  end if;
  if tg_op='UPDATE' and old.promotion_id<>new.promotion_id then
    select funding_source,starts_at into v_promo from promotions where id=old.promotion_id;
    if found and v_promo.funding_source='platform' and v_promo.starts_at<=now() then
      raise exception 'a started marketplace promotion can only be paused, resumed, shortened or given more budget';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
drop trigger if exists promotion_merchants_started_guard on promotion_merchants;
create trigger promotion_merchants_started_guard before insert or update or delete on promotion_merchants
for each row execute function guard_started_platform_promotion_scope();
drop trigger if exists promotion_categories_started_guard on promotion_categories;
create trigger promotion_categories_started_guard before insert or update or delete on promotion_categories
for each row execute function guard_started_platform_promotion_scope();
drop trigger if exists promotion_products_started_guard on promotion_products;
create trigger promotion_products_started_guard before insert or update or delete on promotion_products
for each row execute function guard_started_platform_promotion_scope();

-- ---------------------------------------------------------------------------
-- 3. Budget accounting follows the redemption lifecycle
-- ---------------------------------------------------------------------------
create or replace function sync_platform_promotion_budget()
returns trigger language plpgsql as $$
declare
  v_funding text;
  v_promotion text := case when tg_op='DELETE' then old.promotion_id else new.promotion_id end;
  v_reserved numeric(14,2) := 0;
  v_consumed numeric(14,2) := 0;
begin
  if tg_op='UPDATE' and new.promotion_id<>old.promotion_id then
    raise exception 'promotion redemption cannot move between promotions';
  end if;
  select funding_source into v_funding from promotions where id=v_promotion;
  if v_funding is distinct from 'platform' then
    return case when tg_op='DELETE' then old else new end;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    if old.status='reserved' then v_reserved := v_reserved - old.discount_amount;
    elsif old.status='applied' then v_consumed := v_consumed - old.discount_amount; end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    if new.status='reserved' then v_reserved := v_reserved + new.discount_amount;
    elsif new.status='applied' then v_consumed := v_consumed + new.discount_amount; end if;
  end if;
  if v_reserved<>0 or v_consumed<>0 then
    -- promotion_budgets CHECK (reserved + consumed <= max, both >= 0) is the
    -- hard stop: an over-reservation aborts the whole checkout transaction.
    update promotion_budgets
       set reserved_discount_amount=reserved_discount_amount+v_reserved,
           consumed_discount_amount=consumed_discount_amount+v_consumed,
           version=version+1, updated_at=now()
     where promotion_id=v_promotion;
    if not found then raise exception 'marketplace promotion budget is not configured'; end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

drop trigger if exists promotion_redemption_platform_budget on promotion_redemptions;
create trigger promotion_redemption_platform_budget
after insert or update of status, discount_amount, promotion_id or delete on promotion_redemptions
for each row execute function sync_platform_promotion_budget();

-- ---------------------------------------------------------------------------
-- 4. Paid-order economics stay immutable, now including the funding split.
-- ---------------------------------------------------------------------------
create or replace function public.elemarket_guard_paid_order_economics()
 returns trigger
 language plpgsql
as $fn$
begin
 if old.status not in ('payment_pending','expired') and (
   new.grand_total is distinct from old.grand_total or
   new.product_total is distinct from old.product_total or
   new.delivery_total is distinct from old.delivery_total or
   new.platform_fee is distinct from old.platform_fee or
   new.merchant_net is distinct from old.merchant_net or
   new.platform_funded_discount is distinct from old.platform_funded_discount or
   new.currency is distinct from old.currency or
   new.user_id is distinct from old.user_id or
   new.merchant_id is distinct from old.merchant_id or
   new.group_id is distinct from old.group_id or
   new.delivery_tier is distinct from old.delivery_tier or
   new.delivery_quote_id is distinct from old.delivery_quote_id
 ) then raise exception 'paid order economic and identity snapshot is immutable'; end if;
 return new;
end $fn$;

-- Merchant participation (0065) is consent to FUND a global promotion. A
-- marketplace promotion never touches merchant earnings, so there is nothing
-- to join. Redefined from the live definition; only the funding check is new.
create or replace function public.validate_promotion_participation()
 returns trigger
 language plpgsql
as $fn$
declare
  p record;
  m record;
begin
  select merchant_id,status,starts_at,ends_at,funding_source into p
    from promotions where id=new.promotion_id for update;
  if not found then raise exception 'promotion not found'; end if;
  if p.merchant_id is not null then
    raise exception 'merchant participation is only valid for platform promotions';
  end if;
  if p.funding_source='platform' then
    raise exception 'marketplace promotions are funded by ELEMARKET and need no merchant participation';
  end if;
  select status,verified into m from merchants where id=new.merchant_id;
  if not found or m.status<>'active' or m.verified is not true then
    raise exception 'merchant is not eligible for promotion participation';
  end if;
  if new.status='accepted' and p.status='archived' then
    raise exception 'promotion is archived';
  end if;
  if new.status='accepted' and p.ends_at<=now() then
    raise exception 'promotion has ended';
  end if;
  if new.status='accepted' and new.accepted_at is null then new.accepted_at:=now(); end if;
  if new.status='declined' and new.declined_at is null then new.declined_at:=now(); end if;
  if new.status='withdrawn' and new.withdrawn_at is null then new.withdrawn_at:=now(); end if;
  new.updated_at:=now();
  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Checkout. Redefined from the LIVE definition (pg_get_functiondef after
--    0230). Changes are marked "0234"/"marketplace"; the merchant-funded path
--    is byte-for-byte the previous logic. One promo code per checkout and the
--    single-merchant restriction for promo codes are unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.create_pending_order(p_user_id text, p_idem text, p_fingerprint text, p_items jsonb, p_quotes jsonb, p_address text, p_method text, p_promo_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $fn$
declare
  v_existing record;
  v_group text;
  v_item record;
  v_product record;
  v_variant record;
  v_lines jsonb;
  v_order_item_id bigint;
  v_quote record;
  v_merchant text;
  v_item_merchant text;
  v_category text;
  v_line numeric(12,2);
  v_line_fee numeric(12,2);
  v_unit numeric(12,2);
  v_original_unit numeric(12,2);
  v_product_total numeric(12,2);
  v_platform_fee numeric(12,2);
  v_delivery numeric(12,2);
  v_order text;
  v_pay text;
  v_orders jsonb := '[]'::jsonb;
  v_now timestamptz := now();
  v_count integer;
  v_claimed_user text := current_setting('app.user_id', true);
  v_provider_key text;
  v_rate_bps integer;
  v_promo record;
  v_promo_id text;
  v_promo_discount numeric(12,2) := 0;
  v_eligible_subtotal numeric(12,2) := 0;
  v_cart_subtotal numeric(12,2) := 0;
  v_remaining_discount numeric(12,2) := 0;
  v_line_discount numeric(12,2) := 0;
  v_has_product_scope boolean := false;
  v_has_category_scope boolean := false;
  v_eligible boolean := false;
  v_prior_orders integer := 0;
  v_redemption text;
  v_flash_sale_id text;
  v_flash_sale record;
  v_flash_item record;
  v_flash_discount numeric(12,2) := 0;
  v_flash_redemption text;
  v_flash_ids text[] := '{}';
  v_cart_merchant_count integer := 0;
  v_idx integer;
  v_last jsonb;
  v_absorb numeric(12,2);
  v_line_total numeric(12,2);
  -- 0234 marketplace (ELEMARKET-funded) promotions.
  v_platform_funded boolean := false;
  v_gross_fee numeric(12,2) := 0;
  v_gross_fee_pre numeric(12,2) := 0;
  v_planned_discount numeric(12,2) := 0;
  v_budget record;
begin
  if p_user_id is null or char_length(p_user_id) < 3 or v_claimed_user is null or v_claimed_user <> p_user_id then raise exception 'unauthorized'; end if;
  if p_idem is null or char_length(p_idem) < 16 or char_length(p_idem) > 128 then raise exception 'invalid idempotency key'; end if;
  if p_fingerprint is null or char_length(p_fingerprint) <> 64 then raise exception 'invalid request fingerprint'; end if;
  if p_address is null or char_length(trim(p_address)) < 8 or char_length(trim(p_address)) > 400 then raise exception 'delivery address is required'; end if;
  if p_method not in ('mobile_money', 'card', 'bank_transfer') then raise exception 'unsupported payment method'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 40 then raise exception 'invalid cart'; end if;
  if jsonb_typeof(p_quotes) <> 'array' or jsonb_array_length(p_quotes) < 1 or jsonb_array_length(p_quotes) > 40 then raise exception 'invalid delivery quotes'; end if;
  if p_promo_code is not null and char_length(trim(p_promo_code)) > 64 then raise exception 'invalid promotion code'; end if;
  if p_promo_code is not null and trim(p_promo_code) <> '' and trim(p_promo_code) !~ '^[A-Za-z0-9_-]{4,64}$' then raise exception 'invalid promotion code'; end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:checkout:' || p_user_id, 0));


  select * into v_existing from order_idempotency where idem = p_idem;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.fingerprint <> p_fingerprint then raise exception 'idempotency conflict'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('orderId',o.id,'merchantId',o.merchant_id,'grandTotal',o.grand_total,'status',o.status,'paymentId',p.id) order by o.id),'[]'::jsonb)
      into v_orders from orders o left join payments p on p.order_id=o.id where o.group_id=v_existing.group_id;
    return jsonb_build_object('replay',true,'groupId',v_existing.group_id,'orders',v_orders);
  end if;

  -- Advisory user lock above serializes checkout attempts, including pending-order quotas.
  select count(*) into v_count from orders where user_id=p_user_id and status='payment_pending';
  if v_count + (select count(distinct p.merchant_id) from products p join (select distinct elem->>'productId' as product_id from jsonb_array_elements(p_items) elem) i on i.product_id=p.id) > 3 then raise exception 'too many unpaid orders'; end if;
  if (select coalesce(sum(oi.quantity),0) from order_items oi join orders o on o.id=oi.order_id where o.user_id=p_user_id and o.status='payment_pending') + (select coalesce(sum((elem->>'quantity')::integer),0) from jsonb_array_elements(p_items) elem) > 40 then raise exception 'too many reserved units'; end if;

  select count(*) into v_count from orders where user_id=p_user_id and created_at > v_now - interval '1 minute';
  if v_count >= 8 then raise exception 'too many checkouts; retry shortly'; end if;

  select count(distinct p.merchant_id) into v_cart_merchant_count from products p join (select distinct elem->>'productId' product_id from jsonb_array_elements(p_items) elem) i on i.product_id=p.id;
  -- Quote objects must describe exactly one valid quote for each merchant.
  -- Reject ghost/duplicate entries from native or untrusted clients.
  if v_cart_merchant_count<>jsonb_array_length(p_quotes)
     or v_cart_merchant_count<>(select count(distinct trim(elem->>'merchantId')) from jsonb_array_elements(p_quotes) elem)
  then raise exception 'delivery quotes do not match cart merchants'; end if;
  if nullif(trim(p_promo_code),'') is not null and v_cart_merchant_count > 1 then
    raise exception 'multi-merchant promotions require separate merchant checkouts';
  end if;

  v_group := 'grp_' || replace(gen_random_uuid()::text, '-', '');
  insert into order_groups(id,user_id) values (v_group,p_user_id);
  insert into order_idempotency(idem,user_id,fingerprint,group_id) values (p_idem,p_user_id,p_fingerprint,v_group);

  -- Lock every product/variant in deterministic order before any stock mutation.
  for v_item in
    select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,sum((elem->>'quantity')::int) as qty
      from jsonb_array_elements(p_items) elem group by 1,2 order by 1,2
  loop
    if v_item.product_id is null or v_item.product_id='' or v_item.qty is null or v_item.qty<1 or v_item.qty>20 then raise exception 'invalid cart item'; end if;
    select p.id,p.merchant_id,p.price,p.stock,p.currency,p.name,p.category,p.status as product_status,m.status as merchant_status,m.verified
      into v_product from products p join merchants m on m.id=p.merchant_id where p.id=v_item.product_id for update of p;
    if not found then raise exception 'product not found'; end if;
    if v_product.merchant_status<>'active' or v_product.verified is not true then raise exception 'merchant is not eligible'; end if;
    if v_product.product_status<>'active' then raise exception 'product is not available'; end if;
    if v_item.variant_id is not null then
      select pv.* into v_variant from product_variants pv where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active' for update;
      if not found then raise exception 'variant not found'; end if;
      if v_variant.stock<v_item.qty then raise exception 'insufficient variant stock'; end if;
    else
      if exists (select 1 from product_variants pv where pv.product_id=v_item.product_id and pv.status='active') then
        raise exception 'variant selection required for this product';
      end if;
      if v_product.stock<v_item.qty then raise exception 'insufficient stock'; end if;
    end if;
    if v_product.currency<>'GHS' then raise exception 'unsupported currency'; end if;
  end loop;

  for v_merchant in
    select distinct p.merchant_id from products p join (select distinct trim(elem->>'productId') as product_id from jsonb_array_elements(p_items) elem) i on i.product_id=p.id order by 1
  loop
    select q.* into v_quote from delivery_quotes q where q.id=(select trim(elem->>'quoteId') from jsonb_array_elements(p_quotes) elem where trim(elem->>'merchantId')=v_merchant limit 1) for update;
    if not found then raise exception 'delivery quote missing for merchant'; end if;
    if v_quote.user_id<>p_user_id or v_quote.merchant_id<>v_merchant then raise exception 'delivery quote ownership mismatch'; end if;
    if v_quote.expires_at<=v_now then raise exception 'delivery quote expired'; end if;
    if v_quote.dest_address<>trim(p_address) then raise exception 'delivery quote does not match this address'; end if;

    -- Promotions are evaluated only after the authoritative merchant is known.
    v_promo_id := null;
    v_promo_discount := 0;
    v_eligible_subtotal := 0;
    v_cart_subtotal := 0;
    v_remaining_discount := 0;
    v_platform_funded := false;
    v_gross_fee_pre := 0;
    v_planned_discount := 0;

    -- Always snapshot the authoritative pre-discount merchandise subtotal.
    for v_item in
      select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,sum((elem->>'quantity')::int) as qty
        from jsonb_array_elements(p_items) elem group by 1,2 order by 1,2
    loop
      if v_item.variant_id is not null then
        select pv.price,p.merchant_id,p.category into v_unit,v_item_merchant,v_category from product_variants pv join products p on p.id=pv.product_id where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active';
      else
        select p.price,p.merchant_id,p.category into v_unit,v_item_merchant,v_category from products p where p.id=v_item.product_id;
      end if;
      if v_item_merchant<>v_quote.merchant_id then continue; end if;
      v_cart_subtotal:=v_cart_subtotal+round(v_unit*v_item.qty,2);
      -- ELEMARKET's commission on the undiscounted basket: the most a
      -- marketplace-funded promotion may give away on this merchant order.
      v_gross_fee_pre:=v_gross_fee_pre+round(round(v_unit*v_item.qty,2)*get_commission_rate_bps(v_quote.merchant_id,v_item.product_id,v_category)/10000.0,2);
    end loop;

    -- Flash sales are automatic, scarce inventory promotions. Never stack a coupon
    -- on top of an active flash sale. The sale campaign is locked so eligibility,
    -- per-customer usage and allocation are evaluated atomically.
    select array_agg(distinct fs.id order by fs.id) into v_flash_ids
      from flash_sales fs
      join flash_sale_items fsi on fsi.flash_sale_id=fs.id
      left join product_variants pv on pv.id=fsi.variant_id
      where fs.merchant_id=v_merchant and fs.status='active'
        and fs.starts_at<=v_now and fs.ends_at>v_now
        and ((fsi.variant_id is not null and exists (select 1 from jsonb_array_elements(p_items) e where trim(e->>'variantId')=fsi.variant_id and trim(e->>'productId')=fsi.product_id))
          or (fsi.variant_id is null and exists (select 1 from jsonb_array_elements(p_items) e where trim(e->>'productId')=fsi.product_id and nullif(trim(e->>'variantId'),'') is null)));
    if coalesce(array_length(v_flash_ids,1),0)>1 then
      raise exception 'multiple flash sales cannot be combined in one checkout';
    end if;
    v_flash_sale_id:=case when coalesce(array_length(v_flash_ids,1),0)=1 then v_flash_ids[1] else null end;
    if v_flash_sale_id is not null then
      select * into v_flash_sale from flash_sales where id=v_flash_sale_id for update;
      if p_promo_code is not null and trim(p_promo_code)<>'' then
        raise exception 'promotion cannot be combined with a flash sale';
      end if;
      if (select count(*) from flash_sale_redemptions where flash_sale_id=v_flash_sale_id and user_id=p_user_id and status in ('reserved','consumed')) >= v_flash_sale.per_customer_limit then
        raise exception 'flash sale customer limit reached';
      end if;
    end if;

    if p_promo_code is not null and trim(p_promo_code)<>'' then
      select * into v_promo from promotions where upper(trim(code))=upper(trim(p_promo_code)) for update;
      if not found or v_promo.status<>'active' or v_promo.starts_at>v_now or v_promo.ends_at<=v_now then raise exception 'promotion is not available'; end if;
      if v_promo.currency<>'GHS' then raise exception 'promotion currency mismatch'; end if;
      if v_promo.merchant_id is not null and v_promo.merchant_id<>v_merchant then raise exception 'promotion is not valid for this merchant'; end if;
      v_platform_funded := v_promo.funding_source='platform';
      if v_platform_funded then
        if v_promo.merchant_id is not null then raise exception 'promotion is not available'; end if;
        if exists(select 1 from promotion_merchants where promotion_id=v_promo.id)
           and not exists(select 1 from promotion_merchants where promotion_id=v_promo.id and merchant_id=v_merchant) then
          raise exception 'promotion is not valid for this merchant';
        end if;
      end if;
      if v_promo.usage_limit is not null and (select count(*) from promotion_redemptions where promotion_id=v_promo.id and status in ('reserved','applied'))>=v_promo.usage_limit then raise exception 'promotion usage limit reached'; end if;
      if (select count(*) from promotion_redemptions where promotion_id=v_promo.id and user_id=p_user_id and status in ('reserved','applied'))>=v_promo.per_customer_limit then raise exception 'promotion customer limit reached'; end if;
      if v_promo.first_order_only or v_promo.new_customer_only then
        select count(*) into v_prior_orders from orders where user_id=p_user_id and status in ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed');
        if v_prior_orders>0 then raise exception 'promotion is for new customers only'; end if;
      end if;
      select exists(select 1 from promotion_products where promotion_id=v_promo.id),exists(select 1 from promotion_categories where promotion_id=v_promo.id) into v_has_product_scope,v_has_category_scope;
      for v_item in
        select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,sum((elem->>'quantity')::int) as qty
          from jsonb_array_elements(p_items) elem group by 1,2 order by 1,2
      loop
        if v_item.variant_id is not null then
          select pv.price,p.merchant_id,p.category into v_unit,v_item_merchant,v_category from product_variants pv join products p on p.id=pv.product_id where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active';
        else
          select p.price,p.merchant_id,p.category into v_unit,v_item_merchant,v_category from products p where p.id=v_item.product_id;
        end if;
        if v_item_merchant<>v_quote.merchant_id then continue; end if;
        v_line:=round(v_unit*v_item.qty,2);
        v_eligible:=true;
        if v_has_product_scope and not exists(select 1 from promotion_products where promotion_id=v_promo.id and product_id=v_item.product_id) then v_eligible:=false; end if;
        if v_has_category_scope and not exists(select 1 from promotion_categories where promotion_id=v_promo.id and category=v_category) then v_eligible:=false; end if;
        if v_eligible then v_eligible_subtotal:=v_eligible_subtotal+v_line; end if;
      end loop;
      if v_eligible_subtotal < v_promo.min_subtotal then raise exception 'promotion minimum basket not reached'; end if;
      if v_eligible_subtotal<=0 then raise exception 'promotion does not apply to this cart'; end if;
      if v_promo.discount_type='percentage' then
        v_promo_discount:=round(v_eligible_subtotal*v_promo.discount_value/100.0,2);
      else
        v_promo_discount:=least(v_promo.discount_value,v_eligible_subtotal);
      end if;
      if v_promo.max_discount is not null then v_promo_discount:=least(v_promo_discount,v_promo.max_discount); end if;
      v_promo_discount:=greatest(least(v_promo_discount,v_eligible_subtotal),0);
      if v_platform_funded then
        -- Rule: ELEMARKET pays for this discount out of ITS commission on this
        -- order, never out of the merchant's earnings. Cap at the commission,
        -- less one pesewa: a provider split with a zero platform charge falls
        -- back to the subaccount's default split (see paystack adapter), which
        -- would change what the merchant receives. Keeping platform_fee > 0
        -- keeps the explicit split = merchant_net + delivery.
        v_promo_discount:=round(least(v_promo_discount,v_gross_fee_pre-0.01),2);
        if v_promo_discount<=0 then raise exception 'promotion does not apply to this cart'; end if;
        -- The promotion row is locked above, so budget checks are serialized.
        -- The redemption trigger performs the reservation; the table CHECK is
        -- the final guard that the budget can never be exceeded.
        select * into v_budget from promotion_budgets where promotion_id=v_promo.id for update;
        if not found or v_budget.max_discount_amount is null then raise exception 'promotion is not available'; end if;
        if v_budget.reserved_discount_amount+v_budget.consumed_discount_amount+v_promo_discount>v_budget.max_discount_amount then
          raise exception 'promotion budget exhausted';
        end if;
        v_planned_discount:=v_promo_discount;
      end if;
      v_remaining_discount:=v_promo_discount;
      v_promo_id:=v_promo.id;
    end if;

    v_lines:='[]'::jsonb;
    v_product_total:=0;
    v_platform_fee:=0;
    v_gross_fee:=0;
    v_flash_discount:=0;
    v_order:='ord_'||replace(gen_random_uuid()::text,'-','');
    for v_item in
      select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,sum((elem->>'quantity')::int) as qty
        from jsonb_array_elements(p_items) elem group by 1,2 order by 1,2
    loop
      select p.price,p.merchant_id,p.category into v_original_unit,v_item_merchant,v_category from products p where p.id=v_item.product_id;
      v_unit:=v_original_unit;
      if v_item.variant_id is not null then
        select pv.price,p.merchant_id,p.category into v_unit,v_item_merchant,v_category from product_variants pv join products p on p.id=pv.product_id where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active' for update of pv;
        if not found then raise exception 'variant not found'; end if;
        v_original_unit:=v_unit;
      end if;
      if v_item_merchant<>v_quote.merchant_id then continue; end if;
      v_line:=round(v_original_unit*v_item.qty,2);
      v_gross_fee:=v_gross_fee+round(v_line*get_commission_rate_bps(v_quote.merchant_id,v_item.product_id,v_category)/10000.0,2);
      v_line_discount:=0;
      if v_flash_sale_id is not null then
        select fsi.*,fs.status as sale_status,fs.starts_at,fs.ends_at,fs.per_customer_limit
          into v_flash_item
          from flash_sale_items fsi join flash_sales fs on fs.id=fsi.flash_sale_id
         where fsi.flash_sale_id=v_flash_sale_id
           and fsi.product_id=v_item.product_id
           and ((fsi.variant_id is not null and fsi.variant_id=v_item.variant_id) or (fsi.variant_id is null and v_item.variant_id is null))
         for update of fsi;
        if found then
          if v_flash_item.sale_status<>'active' or v_flash_item.starts_at>v_now or v_flash_item.ends_at<=v_now then
            raise exception 'flash sale is no longer active';
          end if;
          if v_flash_item.quantity_limit is not null and v_flash_item.reserved_quantity + v_flash_item.sold_quantity + v_item.qty > v_flash_item.quantity_limit then
            raise exception 'flash sale allocation exhausted';
          end if;
          v_line_discount:=greatest(round((v_original_unit-v_flash_item.sale_price)*v_item.qty,2),0);
          if v_line_discount<=0 or v_flash_item.sale_price>v_original_unit then
            raise exception 'invalid flash sale price';
          end if;
          update flash_sale_items
             set reserved_quantity=reserved_quantity+v_item.qty, updated_at=now()
           where flash_sale_id=v_flash_sale_id and product_id=v_item.product_id
             and ((variant_id is not null and variant_id=v_item.variant_id) or (variant_id is null and v_item.variant_id is null))
             and (quantity_limit is null or reserved_quantity+sold_quantity+v_item.qty<=quantity_limit);
          if not found then raise exception 'flash sale allocation exhausted'; end if;
          v_flash_discount:=v_flash_discount+v_line_discount;
        end if;
      end if;
      v_eligible:=v_promo_id is not null and v_flash_sale_id is null;
      if v_eligible then
        if v_has_product_scope and not exists(select 1 from promotion_products where promotion_id=v_promo_id and product_id=v_item.product_id) then v_eligible:=false; end if;
        if v_has_category_scope and not exists(select 1 from promotion_categories where promotion_id=v_promo_id and category=v_category) then v_eligible:=false; end if;
        if v_eligible and v_eligible_subtotal>0 then
          if v_promo.discount_type='percentage' then
            v_line_discount:=round(v_line*v_promo.discount_value/100.0,2);
            if v_promo.max_discount is not null then v_line_discount:=least(v_line_discount,v_promo.max_discount); end if;
            -- Cap the aggregate discount at the promotion's authoritative total.
            v_line_discount:=least(v_line_discount,v_remaining_discount);
          else
            v_line_discount:=least(v_line,v_remaining_discount);
          end if;
          v_remaining_discount:=greatest(v_remaining_discount-v_line_discount,0);
        end if;
      end if;
      if v_item.variant_id is not null then
        update product_variants set stock=stock-v_item.qty,updated_at=now() where id=v_item.variant_id and stock>=v_item.qty and status='active';
        if not found then raise exception 'insufficient variant stock'; end if;
      else
        update products set stock=stock-v_item.qty where id=v_item.product_id and stock>=v_item.qty;
        if not found then raise exception 'insufficient stock'; end if;
      end if;
      -- Charge the exact authorized net. unit_price is the per-unit display
      -- of that net; product_total is authoritative when it does not divide evenly.
      v_line:=round(greatest(v_line-v_line_discount,0),2);
      v_unit:=case when v_item.qty<1 then 0 else round(v_line/v_item.qty,2) end;
      v_line_discount:=round(greatest(round(v_original_unit*v_item.qty,2)-v_line,0),2);
      if v_line<0 or v_line>round(v_original_unit*v_item.qty,2) then raise exception 'invalid promotion calculation'; end if;
      v_line_fee:=round(v_line*get_commission_rate_bps(v_quote.merchant_id,v_item.product_id,v_category)/10000.0,2);
      v_rate_bps:=get_commission_rate_bps(v_quote.merchant_id,v_item.product_id,v_category);
      v_product_total:=v_product_total+v_line;
      v_platform_fee:=v_platform_fee+v_line_fee;
      v_lines:=v_lines || jsonb_build_array(jsonb_build_object(
        'product_id',v_item.product_id,'variant_id',v_item.variant_id,'quantity',v_item.qty,
        'unit_price',v_unit,'original_unit_price',v_original_unit,
        'product_total',v_line,'discount_total',v_line_discount));
    end loop;
    -- Per-line rounding can leave a pesewa of the authorized discount unapplied.
    -- Give it back to lines that still have a charge, then recompute commission.
    if v_promo_id is not null and v_remaining_discount > 0 and jsonb_array_length(v_lines) > 0 then
      for v_idx in reverse jsonb_array_length(v_lines) - 1 .. 0 loop
        exit when v_remaining_discount <= 0;
        v_last := v_lines -> v_idx;
        v_line_total := round((v_last->>'product_total')::numeric, 2);
        v_absorb := least(v_remaining_discount, v_line_total);
        if v_absorb > 0 then
          v_line_total := round(v_line_total - v_absorb, 2);
          v_last := jsonb_set(v_last, '{product_total}', to_jsonb(v_line_total));
          v_last := jsonb_set(v_last, '{discount_total}', to_jsonb(round((v_last->>'discount_total')::numeric + v_absorb, 2)));
          v_last := jsonb_set(v_last, '{unit_price}', to_jsonb(round(v_line_total / greatest((v_last->>'quantity')::numeric, 1), 2)));
          v_lines := jsonb_set(v_lines, array[v_idx::text], v_last);
          v_product_total := round(v_product_total - v_absorb, 2);
          v_remaining_discount := round(v_remaining_discount - v_absorb, 2);
        end if;
      end loop;
      v_platform_fee := 0;
      for v_item in select * from jsonb_to_recordset(v_lines) as line(product_id text, product_total numeric) loop
        select p.category into v_category from products p where p.id = v_item.product_id;
        v_platform_fee := v_platform_fee + round(v_item.product_total * get_commission_rate_bps(v_quote.merchant_id, v_item.product_id, v_category) / 10000.0, 2);
      end loop;
    end if;
    if jsonb_array_length(v_lines) < 1 then raise exception 'empty merchant order'; end if;
    -- Use THIS merchant's quote. The delivery fee pays the rider and is always
    -- positive, so a fully discounted basket remains payable for delivery.
    v_delivery:=v_quote.price;
    if v_delivery is null or v_delivery <= 0 then raise exception 'invalid delivery quote price'; end if;
    if v_product_total is null or v_product_total < 0 or v_product_total + v_delivery <= 0 then raise exception 'empty merchant order'; end if;
    if v_flash_sale_id is not null then
      v_promo_discount:=round(v_cart_subtotal-v_product_total,2);
      if v_promo_discount<>round(v_flash_discount,2) then raise exception 'flash sale discount integrity failure'; end if;
    end if;
    -- Rounding invariant: line-level discounts must equal the authoritative promotion amount.
    if v_promo_id is not null then
      v_promo_discount:=round(v_cart_subtotal-v_product_total,2);
      if v_promo_discount<0 then raise exception 'invalid promotion total'; end if;
      if v_promo_discount > v_eligible_subtotal then raise exception 'promotion exceeds eligible subtotal'; end if;
    end if;
    if v_platform_funded then
      -- Customer pays (cart - D). ELEMARKET keeps (commission - D). The
      -- merchant keeps exactly (cart - commission), as without the promotion.
      if v_gross_fee<>v_gross_fee_pre then raise exception 'promotion commission integrity failure'; end if;
      if v_promo_discount<>v_planned_discount then raise exception 'promotion discount integrity failure'; end if;
      v_platform_fee:=round(v_gross_fee-v_promo_discount,2);
      if v_platform_fee<=0 then raise exception 'promotion exceeds marketplace commission'; end if;
      if round(v_product_total-v_platform_fee,2)<>round(v_cart_subtotal-v_gross_fee,2) then raise exception 'promotion merchant earnings integrity failure'; end if;
    end if;
    insert into orders(id,group_id,user_id,merchant_id,status,currency,product_total,delivery_total,platform_fee,merchant_net,grand_total,delivery_tier,delivery_quote_id,address,promo_discount,promo_code,promo_id,flash_sale_id,original_product_total,payment_deadline,platform_funded_discount)
    values(v_order,v_group,p_user_id,v_quote.merchant_id,'payment_pending','GHS',v_product_total,v_delivery,v_platform_fee,v_product_total-v_platform_fee,v_product_total+v_delivery,v_quote.tier,v_quote.id,trim(p_address),v_promo_discount,nullif(upper(trim(p_promo_code)),''),v_promo_id,v_flash_sale_id,v_cart_subtotal,v_now + interval '15 minutes',case when v_platform_funded then v_promo_discount else 0 end);

    for v_item in select * from jsonb_to_recordset(v_lines) as line(
      product_id text,variant_id text,quantity integer,unit_price numeric,
      original_unit_price numeric,product_total numeric,discount_total numeric)
    loop
      insert into order_items(order_id,product_id,variant_id,quantity,unit_price,original_unit_price,currency,product_total,discount_total)
      values(v_order,v_item.product_id,v_item.variant_id,v_item.quantity,v_item.unit_price,v_item.original_unit_price,'GHS',v_item.product_total,v_item.discount_total)
      returning id into v_order_item_id;
      insert into order_stock_reservations(order_id,order_item_id,product_id,variant_id,quantity)
      values(v_order,v_order_item_id,v_item.product_id,v_item.variant_id,v_item.quantity);
    end loop;

    if v_promo_id is not null then
      v_redemption:='pr_'||replace(gen_random_uuid()::text,'-','');
      insert into promotion_redemptions(id,promotion_id,order_id,user_id,code_snapshot,discount_amount,status)
      values(v_redemption,v_promo_id,v_order,p_user_id,upper(trim(p_promo_code)),v_promo_discount,'reserved');
    end if;

    if v_flash_sale_id is not null then
      v_flash_redemption:='fsr_'||replace(gen_random_uuid()::text,'-','');
      insert into flash_sale_redemptions(id,flash_sale_id,order_id,user_id,discount_amount,status)
      values(v_flash_redemption,v_flash_sale_id,v_order,p_user_id,round(v_cart_subtotal-v_product_total,2),'reserved');
    end if;

    insert into order_commission_snapshots(order_id,product_id,merchant_id,product_total,rate_bps,commission_amount)
    select s.order_id,s.product_id,v_quote.merchant_id,s.basis,s.rate,round(s.basis*s.rate/10000.0,2)
      from (
        -- A marketplace-funded discount does not change the merchant's commission
        -- basis: snapshot the commission on the undiscounted line.
        select oi.order_id,oi.product_id,
               case when v_platform_funded then round(oi.original_unit_price*oi.quantity,2) else oi.product_total end as basis,
               get_commission_rate_bps(v_quote.merchant_id,oi.product_id,p.category) as rate
          from order_items oi join products p on p.id=oi.product_id where oi.order_id=v_order
      ) s;

    select pp.provider_key into v_provider_key from payment_providers pp where pp.method=p_method and pp.status='active' order by pp.provider_key limit 1;
    if v_provider_key is null then raise exception 'No active payment provider configured for %',p_method; end if;
    v_pay:='pay_'||replace(gen_random_uuid()::text,'-','');
    insert into payments(id,order_id,user_id,amount,currency,method,status,provider_key,client_reference)
    values(v_pay,v_order,p_user_id,v_product_total+v_delivery,'GHS',p_method,'initiated',v_provider_key,v_pay);
    v_orders:=v_orders||jsonb_build_array(jsonb_build_object('orderId',v_order,'merchantId',v_quote.merchant_id,'grandTotal',v_product_total+v_delivery,'productTotal',v_product_total,'deliveryTotal',v_delivery,'promoDiscount',v_promo_discount,'platformFundedDiscount',case when v_platform_funded then v_promo_discount else 0 end,'promoCode',nullif(upper(trim(p_promo_code)),''),'status','payment_pending','paymentId',v_pay));
  end loop;

  if jsonb_array_length(v_orders)<1 then raise exception 'checkout produced no orders'; end if;
  return jsonb_build_object('replay',false,'groupId',v_group,'orders',v_orders);
end;
$fn$;
