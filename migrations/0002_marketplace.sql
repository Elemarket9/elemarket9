-- ELEMARKET hardened marketplace schema.
-- Prices, stock and delivery fees are server-authoritative.
-- Per-user rows are always scoped by user_id in application queries.

create table if not exists merchants (
  id text primary key,
  name text not null check (char_length(name) between 2 and 160),
  category text not null,
  status text not null check (status in ('pending', 'active', 'suspended')),
  verified boolean not null default false,
  tier text not null default 'merchant' check (tier in ('merchant', 'verified_brand', 'enterprise')),
  description text not null default '' check (char_length(description) <= 2000),
  address text not null check (char_length(address) between 4 and 400),
  city text not null,
  neighborhood text not null,
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  created_at timestamptz not null default now()
);

create table if not exists products (
  id text primary key,
  merchant_id text not null references merchants(id),
  name text not null check (char_length(name) between 2 and 200),
  category text not null,
  listing_type text not null default 'product' check (listing_type in ('product', 'food', 'stay')),
  price numeric(12,2) not null check (price > 0 and price <= 100000000),
  currency char(3) not null default 'GHS' check (currency = 'GHS'),
  stock integer not null check (stock >= 0 and stock <= 1000000),
  description text not null default '' check (char_length(description) <= 4000),
  image_path text,
  meal_type text,
  cuisine text,
  prep_minutes integer check (prep_minutes is null or prep_minutes between 1 and 720),
  guests integer check (guests is null or guests between 1 and 16),
  created_at timestamptz not null default now()
);

create index if not exists products_merchant_idx on products (merchant_id);
create index if not exists products_category_idx on products (category, listing_type);
create index if not exists products_stock_idx on products (stock) where stock > 0;

create table if not exists profiles (
  user_id text primary key,
  name text not null check (char_length(name) between 2 and 120),
  phone text check (phone is null or char_length(phone) between 8 and 20),
  address text check (address is null or char_length(address) between 8 and 400),
  lat double precision check (lat is null or lat between -90 and 90),
  lon double precision check (lon is null or lon between -180 and 180),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_phone_uq on profiles (phone) where phone is not null;

create table if not exists delivery_quotes (
  id text primary key,
  user_id text not null,
  merchant_id text not null references merchants(id),
  fingerprint text not null,
  tier text not null check (tier in ('same_day', 'next_day', 'three_day')),
  price numeric(12,2) not null check (price >= 0 and price <= 10000),
  eta_minutes integer not null check (eta_minutes > 0 and eta_minutes <= 10080),
  distance_km numeric(8,3) not null check (distance_km >= 0 and distance_km <= 100),
  dest_address text not null,
  dest_lat double precision,
  dest_lon double precision,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists delivery_quotes_user_idx on delivery_quotes (user_id, expires_at);

create table if not exists order_groups (
  id text primary key,
  user_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists order_idempotency (
  idem text primary key check (char_length(idem) between 16 and 128),
  user_id text not null,
  fingerprint text not null,
  group_id text not null references order_groups(id),
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id text primary key,
  group_id text not null references order_groups(id),
  user_id text not null,
  merchant_id text not null references merchants(id),
  status text not null check (status in (
    'paid', 'confirmed', 'fulfilling', 'shipped', 'delivered', 'completed', 'cancelled', 'disputed'
  )),
  currency char(3) not null default 'GHS' check (currency = 'GHS'),
  product_total numeric(12,2) not null check (product_total >= 0),
  delivery_total numeric(12,2) not null check (delivery_total >= 0),
  platform_fee numeric(12,2) not null default 0 check (platform_fee >= 0),
  merchant_net numeric(12,2) not null check (merchant_net >= 0),
  grand_total numeric(12,2) not null check (grand_total >= 0),
  delivery_tier text not null check (delivery_tier in ('same_day', 'next_day', 'three_day')),
  delivery_quote_id text not null references delivery_quotes(id),
  address text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_totals_add check (grand_total = product_total + delivery_total)
);

create index if not exists orders_user_idx on orders (user_id, created_at desc);
create index if not exists orders_merchant_idx on orders (merchant_id, status);

create table if not exists order_items (
  id bigserial primary key,
  order_id text not null references orders(id),
  product_id text not null references products(id),
  quantity integer not null check (quantity > 0 and quantity <= 20),
  unit_price numeric(12,2) not null check (unit_price > 0),
  currency char(3) not null default 'GHS',
  product_total numeric(12,2) not null check (product_total > 0)
);

create index if not exists order_items_order_idx on order_items (order_id);

create table if not exists payments (
  id text primary key,
  order_id text not null references orders(id),
  user_id text not null,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'GHS',
  method text not null check (method in ('mobile_money', 'card', 'bank_transfer')),
  status text not null check (status in ('completed', 'failed')),
  created_at timestamptz not null default now()
);

create unique index if not exists payments_order_uq on payments (order_id);

create table if not exists reviews (
  id text primary key,
  user_id text not null,
  product_id text not null references products(id),
  order_id text not null references orders(id),
  rating integer not null check (rating between 1 and 5),
  body text not null check (char_length(body) between 8 and 1000),
  created_at timestamptz not null default now(),
  unique (user_id, product_id, order_id)
);

create table if not exists merchant_applications (
  id text primary key,
  user_id text not null,
  business_name text not null check (char_length(business_name) between 2 and 160),
  category text not null,
  address text not null check (char_length(address) between 8 and 400),
  contact text not null check (char_length(contact) between 4 and 80),
  status text not null default 'pending' check (status in ('pending', 'reviewing', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create unique index if not exists merchant_applications_open_uq
  on merchant_applications (user_id) where status in ('pending', 'reviewing');

-- Atomic paid checkout. Client prices are ignored. Stock is decremented
-- only inside this transaction. Idempotent on (idem, fingerprint).
create or replace function place_paid_order(
  p_user_id text,
  p_idem text,
  p_fingerprint text,
  p_items jsonb,
  p_quotes jsonb,
  p_address text,
  p_method text
) returns jsonb
language plpgsql
as $$
declare
  v_existing record;
  v_group text;
  v_item record;
  v_product record;
  v_quote record;
  v_merchant text;
  v_item_merchant text;
  v_qty integer;
  v_unit numeric(12,2);
  v_line numeric(12,2);
  v_product_total numeric(12,2);
  v_delivery numeric(12,2);
  v_order text;
  v_pay text;
  v_orders jsonb := '[]'::jsonb;
  v_now timestamptz := now();
  v_count integer;
begin
  if p_user_id is null or char_length(p_user_id) < 3 then
    raise exception 'unauthorized';
  end if;
  if p_idem is null or char_length(p_idem) < 16 or char_length(p_idem) > 128 then
    raise exception 'invalid idempotency key';
  end if;
  if p_address is null or char_length(trim(p_address)) < 8 or char_length(p_address) > 400 then
    raise exception 'delivery address is required';
  end if;
  if p_method not in ('mobile_money', 'card', 'bank_transfer') then
    raise exception 'unsupported payment method';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 40 then
    raise exception 'invalid cart';
  end if;

  perform pg_advisory_xact_lock(hashtext('elemarket:checkout:' || p_user_id));

  select * into v_existing from order_idempotency where idem = p_idem;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.fingerprint <> p_fingerprint then
      raise exception 'idempotency conflict';
    end if;
    select jsonb_agg(jsonb_build_object(
      'orderId', o.id,
      'merchantId', o.merchant_id,
      'grandTotal', o.grand_total,
      'status', o.status
    )) into v_orders from orders o where o.group_id = v_existing.group_id;
    return jsonb_build_object('replay', true, 'groupId', v_existing.group_id, 'orders', coalesce(v_orders, '[]'::jsonb));
  end if;

  select count(*) into v_count
  from orders
  where user_id = p_user_id and created_at > v_now - interval '1 minute';
  if v_count >= 8 then
    raise exception 'too many checkouts; retry shortly';
  end if;

  v_group := 'grp_' || replace(gen_random_uuid()::text, '-', '');
  insert into order_groups(id, user_id) values (v_group, p_user_id);
  insert into order_idempotency(idem, user_id, fingerprint, group_id)
    values (p_idem, p_user_id, p_fingerprint, v_group);

  for v_item in
    select e.product_id, e.qty from (
      select trim(elem->>'productId') as product_id,
             sum((elem->>'quantity')::int) as qty
      from jsonb_array_elements(p_items) elem
      group by 1
    ) e
    order by e.product_id
  loop
    if v_item.product_id is null or v_item.product_id = '' or v_item.qty is null or v_item.qty < 1 or v_item.qty > 20 then
      raise exception 'invalid cart item';
    end if;
    select p.id, p.merchant_id, p.price, p.stock, p.currency, p.name, m.status, m.verified
      into v_product
    from products p
    join merchants m on m.id = p.merchant_id
    where p.id = v_item.product_id
    for update of p;
    if not found then
      raise exception 'product not found';
    end if;
    if v_product.status <> 'active' or v_product.verified is not true then
      raise exception 'merchant is not eligible';
    end if;
    if v_product.stock < v_item.qty then
      raise exception 'insufficient stock for %', v_product.name;
    end if;
  end loop;

  for v_merchant in
    select distinct p.merchant_id
    from products p
    join (
      select trim(elem->>'productId') as product_id
      from jsonb_array_elements(p_items) elem
    ) i on i.product_id = p.id
    order by 1
  loop
    select q.* into v_quote
    from delivery_quotes q
    where q.id = (
      select trim(elem->>'quoteId')
      from jsonb_array_elements(p_quotes) elem
      where trim(elem->>'merchantId') = v_merchant
      limit 1
    )
    for update;
    if not found then
      raise exception 'delivery quote missing for merchant';
    end if;
    if v_quote.user_id <> p_user_id or v_quote.merchant_id <> v_merchant then
      raise exception 'delivery quote ownership mismatch';
    end if;
    if v_quote.expires_at <= v_now then
      raise exception 'delivery quote expired';
    end if;
    if v_quote.dest_address <> trim(p_address) then
      raise exception 'delivery quote does not match this address';
    end if;

    v_product_total := 0;
    v_order := 'ord_' || replace(gen_random_uuid()::text, '-', '');

    for v_item in
      select trim(elem->>'productId') as product_id,
             sum((elem->>'quantity')::int) as qty
      from jsonb_array_elements(p_items) elem
      group by 1
      order by 1
    loop
      select p.price, p.merchant_id into v_unit, v_item_merchant
      from products p where p.id = v_item.product_id;
      if v_item_merchant <> v_quote.merchant_id then
        continue;
      end if;
      update products
        set stock = stock - v_item.qty
        where id = v_item.product_id and stock >= v_item.qty;
      if not found then
        raise exception 'insufficient stock';
      end if;
      v_line := round(v_unit * v_item.qty, 2);
      v_product_total := v_product_total + v_line;
      insert into order_items(order_id, product_id, quantity, unit_price, currency, product_total)
        values (v_order, v_item.product_id, v_item.qty, v_unit, 'GHS', v_line);
    end loop;

    if v_product_total <= 0 then
      raise exception 'empty merchant order';
    end if;
    v_delivery := v_quote.price;
    insert into orders(
      id, group_id, user_id, merchant_id, status, currency,
      product_total, delivery_total, platform_fee, merchant_net, grand_total,
      delivery_tier, delivery_quote_id, address
    ) values (
      v_order, v_group, p_user_id, v_quote.merchant_id, 'paid', 'GHS',
      v_product_total, v_delivery, 0, v_product_total, v_product_total + v_delivery,
      v_quote.tier, v_quote.id, trim(p_address)
    );
    v_pay := 'pay_' || replace(gen_random_uuid()::text, '-', '');
    insert into payments(id, order_id, user_id, amount, currency, method, status)
      values (v_pay, v_order, p_user_id, v_product_total + v_delivery, 'GHS', p_method, 'completed');
    v_orders := v_orders || jsonb_build_array(jsonb_build_object(
      'orderId', v_order,
      'merchantId', v_quote.merchant_id,
      'grandTotal', v_product_total + v_delivery,
      'status', 'paid'
    ));
  end loop;

  if jsonb_array_length(v_orders) < 1 then
    raise exception 'checkout produced no orders';
  end if;

  return jsonb_build_object('replay', false, 'groupId', v_group, 'orders', v_orders);
end;
$$;

-- Seed catalog (Accra). Coordinates are public storefront locations.
insert into merchants (id, name, category, status, verified, tier, description, address, city, neighborhood, lat, lon) values
  ('mer_labone_kitchen', 'Labone Kitchen', 'restaurants', 'active', true, 'verified_brand', 'Verified kitchen serving Ghanaian plates with same-day delivery across Accra.', '14 Labone Crescent, Accra', 'Accra', 'Labone', 5.5654, -0.1682),
  ('mer_makola', 'Makola Fresh', 'groceries', 'active', true, 'merchant', 'Daily produce stall with tomatoes, grains and household staples from Makola Market.', 'Makola Market, Kojo Thompson Rd', 'Accra', 'Makola', 5.5478, -0.2071),
  ('mer_osu_atelier', 'Osu Atelier', 'fashion', 'active', true, 'verified_brand', 'Tailored cloth, Ankara and leather goods from Oxford Street makers.', 'Oxford Street, Osu', 'Accra', 'Osu', 5.5581, -0.1744),
  ('mer_eastlegon_tech', 'East Legon Tech', 'electronics', 'active', true, 'merchant', 'Phones and everyday electronics with sealed stock and local warranty handling.', 'American House, East Legon', 'Accra', 'East Legon', 5.6362, -0.1508),
  ('mer_circle_beauty', 'Circle Shea Co.', 'beauty', 'active', true, 'merchant', 'Unrefined shea and hair care from northern Ghana cooperatives.', 'Ring Road Central', 'Accra', 'Circle', 5.5710, -0.2050),
  ('mer_madina_agri', 'Madina Agritrade', 'agriculture', 'active', true, 'merchant', 'Cocoa, grains and farm inputs for households and small traders.', 'Madina Market Road', 'Accra', 'Madina', 5.6831, -0.1677),
  ('mer_tema_home', 'Tema Houseworks', 'home', 'active', true, 'merchant', 'Solid wood furniture and household pieces made in Tema.', 'Community 8, Tema', 'Tema', 'Community 8', 5.6690, -0.0167),
  ('mer_cantonments_stay', 'Cantonments Stay', 'hospitality', 'active', true, 'verified_brand', 'Verified short-stay apartments. Host payouts are not custody of ELEMARKET.', 'Fifth Avenue, Cantonments', 'Accra', 'Cantonments', 5.5788, -0.1732)
on conflict (id) do nothing;

insert into products (id, merchant_id, name, category, listing_type, price, stock, description, image_path, meal_type, cuisine, prep_minutes, guests) values
  ('p_jollof', 'mer_labone_kitchen', 'Party jollof with chicken', 'food', 'food', 48.00, 40, 'Tomato-red jollof, fried plantain and grilled chicken. Prepared to order.', '/products/jollof.jpg', 'main', 'ghanaian', 35, null),
  ('p_waakye', 'mer_labone_kitchen', 'Waakye plate', 'food', 'food', 36.00, 50, 'Rice and beans with stew, egg, fried fish and spaghetti.', '/products/waakye.jpg', 'lunch', 'ghanaian', 25, null),
  ('p_kelewele', 'mer_labone_kitchen', 'Kelewele', 'food', 'food', 22.00, 80, 'Spiced fried plantain cubes. Best eaten hot.', '/products/kelewele.jpg', 'snack', 'ghanaian', 15, null),
  ('p_banku', 'mer_labone_kitchen', 'Banku and tilapia', 'food', 'food', 85.00, 24, 'Banku with grilled tilapia and pepper sauce.', '/products/banku.jpg', 'dinner', 'ghanaian', 40, null),
  ('p_tomatoes', 'mer_makola', 'Crate of ripe tomatoes', 'groceries', 'product', 90.00, 30, 'Morning-picked tomatoes from Makola. Sold by the crate.', '/products/tomatoes.jpg', null, null, null, null),
  ('p_rice', 'mer_makola', 'Local rice 5 kg', 'groceries', 'product', 95.00, 60, 'Milled Ghanaian long-grain rice. Staple bag for the week.', '/products/tomatoes.jpg', null, null, null, null),
  ('p_shea', 'mer_circle_beauty', 'Unrefined shea butter 250 ml', 'beauty', 'product', 65.00, 90, 'Whipped unrefined shea from northern cooperatives. No fragrance added.', '/products/shea.jpg', null, null, null, null),
  ('p_kente', 'mer_osu_atelier', 'Handwoven kente stole', 'fashion', 'product', 280.00, 12, 'Narrow kente stole, geometric weave. One-of-a-kind panel.', '/products/kente.jpg', null, null, null, null),
  ('p_dress', 'mer_osu_atelier', 'Ankara midi dress', 'fashion', 'product', 190.00, 18, 'Tailored midi in indigo and rust Ankara. Ready-to-wear, size chart in description.', '/products/dress.jpg', null, null, null, null),
  ('p_bag', 'mer_osu_atelier', 'Structured leather tote', 'fashion', 'product', 340.00, 10, 'Tan leather tote from Accra makers. Unbranded hardware.', '/products/dress.jpg', null, null, null, null),
  ('p_sneakers', 'mer_osu_atelier', 'Court sneakers', 'fashion', 'product', 450.00, 16, 'White leather court sneaker with gum sole. EU 36–45.', '/products/sneakers.jpg', null, null, null, null),
  ('p_phone', 'mer_eastlegon_tech', 'A25 5G unlocked', 'electronics', 'product', 1850.00, 8, 'Unlocked 5G phone. Sealed carton. ELEMARKET does not unlock carrier accounts.', '/products/phone.jpg', null, null, null, null),
  ('p_earbuds', 'mer_eastlegon_tech', 'Wireless earbuds', 'electronics', 'product', 180.00, 40, 'Compact wireless earbuds with charging case.', '/products/phone.jpg', null, null, null, null),
  ('p_laptop', 'mer_eastlegon_tech', '14-inch notebook', 'electronics', 'product', 4200.00, 5, '14-inch notebook for work. Local one-year handling through the merchant.', '/products/phone.jpg', null, null, null, null),
  ('p_cocoa', 'mer_madina_agri', 'Roasted cocoa beans 1 kg', 'agriculture', 'product', 75.00, 70, 'Roasted Ghana cocoa beans for cooking and grinding.', '/products/shea.jpg', null, null, null, null),
  ('p_sofa', 'mer_tema_home', 'Two-seat teak sofa', 'home', 'product', 2400.00, 4, 'Solid teak two-seater. Delivery assembled in Accra/Tema.', '/products/kente.jpg', null, null, null, null),
  ('p_stay_garden', 'mer_cantonments_stay', 'Garden apartment, Cantonments', 'hospitality', 'stay', 650.00, 12, 'Bright one-bedroom with courtyard light. Nightly rate. Cleaning fee included in checkout delivery line as stay service.', '/products/dress.jpg', null, null, null, 3),
  ('p_stay_osu', 'mer_cantonments_stay', 'Studio near Oxford Street', 'hospitality', 'stay', 420.00, 20, 'Self-check-in studio. Nightly rate for up to two guests.', '/products/jollof.jpg', null, null, null, 2)
on conflict (id) do nothing;
