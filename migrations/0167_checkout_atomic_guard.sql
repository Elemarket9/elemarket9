-- Atomic checkout security: preserve the full validated checkout implementation and allow its existing per-merchant order loop.
-- Preserve product currency during variant checks and create the parent order
-- before its lines, so immediate ownership and reservation triggers can validate.
-- Totals, discounts and stock mutations remain in the same atomic transaction.
CREATE OR REPLACE FUNCTION public.create_pending_order(p_user_id text, p_idem text, p_fingerprint text, p_items jsonb, p_quotes jsonb, p_address text, p_method text, p_promo_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
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
    select p.id,p.merchant_id,p.price,p.stock,p.currency,p.name,p.category,m.status,m.verified
      into v_product from products p join merchants m on m.id=p.merchant_id where p.id=v_item.product_id for update of p;
    if not found then raise exception 'product not found'; end if;
    if v_product.status<>'active' or v_product.verified is not true then raise exception 'merchant is not eligible'; end if;
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

    -- Always snapshot the authoritative pre-discount merchandise subtotal.
    for v_item in
      select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,sum((elem->>'quantity')::int) as qty
        from jsonb_array_elements(p_items) elem group by 1,2 order by 1,2
    loop
      if v_item.variant_id is not null then
        select pv.price,p.merchant_id into v_unit,v_item_merchant from product_variants pv join products p on p.id=pv.product_id where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active';
      else
        select p.price,p.merchant_id into v_unit,v_item_merchant from products p where p.id=v_item.product_id;
      end if;
      if v_item_merchant<>v_quote.merchant_id then continue; end if;
      v_cart_subtotal:=v_cart_subtotal+round(v_unit*v_item.qty,2);
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
      if v_cart_subtotal < v_promo.min_subtotal then raise exception 'promotion minimum basket not reached'; end if;
      if v_eligible_subtotal<=0 then raise exception 'promotion does not apply to this cart'; end if;
      if v_promo.discount_type='percentage' then
        v_promo_discount:=round(v_eligible_subtotal*v_promo.discount_value/100.0,2);
      else
        v_promo_discount:=least(v_promo.discount_value,v_eligible_subtotal);
      end if;
      if v_promo.max_discount is not null then v_promo_discount:=least(v_promo_discount,v_promo.max_discount); end if;
      v_promo_discount:=greatest(least(v_promo_discount,v_eligible_subtotal),0);
      v_remaining_discount:=v_promo_discount;
      v_promo_id:=v_promo.id;
    end if;

    v_lines:='[]'::jsonb;
    v_product_total:=0;
    v_platform_fee:=0;
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
      -- Unit prices are stored to cents. Round the customer price UP so
      -- cent rounding can never create a larger discount than authorized.
      v_unit:=ceil(((v_line-v_line_discount)/v_item.qty)*100.0)/100.0;
      v_line:=round(v_unit*v_item.qty,2);
      -- Recompute the actual discount from the immutable original line value.
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
    if v_product_total<=0 then raise exception 'empty merchant order'; end if;
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
    v_delivery:=v_quote.price;
    insert into orders(id,group_id,user_id,merchant_id,status,currency,product_total,delivery_total,platform_fee,merchant_net,grand_total,delivery_tier,delivery_quote_id,address,promo_discount,promo_code,promo_id,flash_sale_id,original_product_total)
    values(v_order,v_group,p_user_id,v_quote.merchant_id,'payment_pending','GHS',v_product_total,v_delivery,v_platform_fee,v_product_total-v_platform_fee,v_product_total+v_delivery,v_quote.tier,v_quote.id,trim(p_address),v_promo_discount,nullif(upper(trim(p_promo_code)),''),v_promo_id,v_flash_sale_id,v_cart_subtotal);

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
    select oi.order_id,oi.product_id,v_quote.merchant_id,oi.product_total,get_commission_rate_bps(v_quote.merchant_id,oi.product_id,p.category),round(oi.product_total*get_commission_rate_bps(v_quote.merchant_id,oi.product_id,p.category)/10000.0,2)
      from order_items oi join products p on p.id=oi.product_id where oi.order_id=v_order;

    select pp.provider_key into v_provider_key from payment_providers pp where pp.method=p_method and pp.status='active' order by pp.provider_key limit 1;
    if v_provider_key is null then raise exception 'No active payment provider configured for %',p_method; end if;
    v_pay:='pay_'||replace(gen_random_uuid()::text,'-','');
    insert into payments(id,order_id,user_id,amount,currency,method,status,provider_key,client_reference)
    values(v_pay,v_order,p_user_id,v_product_total+v_delivery,'GHS',p_method,'initiated',v_provider_key,v_pay);
    v_orders:=v_orders||jsonb_build_array(jsonb_build_object('orderId',v_order,'merchantId',v_quote.merchant_id,'grandTotal',v_product_total+v_delivery,'productTotal',v_product_total,'deliveryTotal',v_delivery,'promoDiscount',v_promo_discount,'promoCode',nullif(upper(trim(p_promo_code)),''),'status','payment_pending','paymentId',v_pay));
  end loop;

  if jsonb_array_length(v_orders)<1 then raise exception 'checkout produced no orders'; end if;
  return jsonb_build_object('replay',false,'groupId',v_group,'orders',v_orders);
end;
$function$;
