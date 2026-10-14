-- ELEMARKET v1.99.6: provider-neutral customer engagement + catalog growth.
-- No external provider is required by these tables. Notification delivery remains
-- behind ELEMARKET notification adapters; these rows only store marketplace intent.

create table if not exists customer_wishlist (
  user_id text not null,
  product_id text not null references products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id, product_id)
);
create index if not exists customer_wishlist_user_created_idx on customer_wishlist(user_id, created_at desc);

create table if not exists customer_recent_products (
  user_id text not null,
  product_id text not null references products(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key(user_id, product_id)
);
create index if not exists customer_recent_products_user_viewed_idx on customer_recent_products(user_id, viewed_at desc);

create table if not exists saved_searches (
  id text primary key,
  user_id text not null,
  name text not null check(char_length(trim(name)) between 1 and 80),
  query jsonb not null,
  notify boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, name)
);
create index if not exists saved_searches_user_idx on saved_searches(user_id, updated_at desc);

create table if not exists back_in_stock_subscriptions (
  user_id text not null,
  product_id text not null references products(id) on delete cascade,
  status text not null default 'active' check(status in ('active','notified','cancelled')),
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  primary key(user_id, product_id)
);
create index if not exists back_in_stock_active_idx on back_in_stock_subscriptions(product_id, created_at) where status='active';

create table if not exists product_questions (
  id text primary key,
  product_id text not null references products(id) on delete cascade,
  user_id text not null,
  question text not null check(char_length(trim(question)) between 5 and 1000),
  status text not null default 'published' check(status in ('published','hidden','answered')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists product_questions_product_idx on product_questions(product_id, created_at desc) where status <> 'hidden';

create table if not exists product_answers (
  id text primary key,
  question_id text not null references product_questions(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  actor_user_id text not null,
  answer text not null check(char_length(trim(answer)) between 2 and 1500),
  created_at timestamptz not null default now(),
  unique(question_id)
);

create table if not exists customer_loyalty_accounts (
  user_id text primary key,
  points_balance bigint not null default 0 check(points_balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists customer_loyalty_ledger (
  id text primary key,
  user_id text not null,
  points_delta integer not null check(points_delta <> 0 and abs(points_delta) <= 1000000),
  event_type text not null check(char_length(event_type) between 2 and 80),
  reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, event_type, reference)
);
create index if not exists customer_loyalty_ledger_user_idx on customer_loyalty_ledger(user_id, created_at desc);

-- Keep recent-view storage bounded so passive browsing cannot grow without limit.
create or replace function record_customer_product_view(p_user_id text, p_product_id text)
returns void language plpgsql as $$
begin
  if p_user_id is null or length(trim(p_user_id)) < 1 then raise exception 'customer identity required'; end if;
  if not exists(select 1 from products p join merchants m on m.id=p.merchant_id where p.id=p_product_id and p.status='active' and m.status='active' and m.verified=true) then
    raise exception 'product unavailable';
  end if;
  insert into customer_recent_products(user_id,product_id,viewed_at)
  values(p_user_id,p_product_id,now())
  on conflict(user_id,product_id) do update set viewed_at=excluded.viewed_at;
  delete from customer_recent_products
   where user_id=p_user_id and product_id in (
     select product_id from customer_recent_products where user_id=p_user_id order by viewed_at desc offset 100
   );
end;
$$;

create or replace function answer_product_question(p_question_id text,p_merchant_id text,p_actor_user_id text,p_answer text)
returns jsonb language plpgsql as $$
declare v_q record; v_id text;
begin
  if p_answer is null or length(trim(p_answer)) < 2 or length(trim(p_answer)) > 1500 then raise exception 'invalid answer'; end if;
  select q.*,p.merchant_id into v_q from product_questions q join products p on p.id=q.product_id where q.id=p_question_id for update;
  if not found then raise exception 'question not found'; end if;
  if v_q.merchant_id <> p_merchant_id then raise exception 'merchant ownership required'; end if;
  if v_q.status='hidden' then raise exception 'question is not available'; end if;
  if exists(select 1 from product_answers where question_id=p_question_id) then raise exception 'question already answered'; end if;
  v_id:='pans_'||replace(gen_random_uuid()::text,'-','');
  insert into product_answers(id,question_id,merchant_id,actor_user_id,answer) values(v_id,p_question_id,p_merchant_id,p_actor_user_id,left(trim(p_answer),1500));
  update product_questions set status='answered',updated_at=now() where id=p_question_id;
  perform record_audit_event('merchant.product_question.answered','product_question',p_question_id,p_actor_user_id,'merchant',null,'success',jsonb_build_object('merchantId',p_merchant_id));
  return jsonb_build_object('answerId',v_id,'status','answered');
end;
$$;

comment on table back_in_stock_subscriptions is 'Marketplace notification intent only. Delivery is performed by the configured notification capability, never by a hardcoded provider.';
comment on table customer_loyalty_ledger is 'Provider-neutral loyalty accounting. No automatic earning/redemption policy is implied by schema creation.';

create or replace function merchant_bulk_create_products(p_merchant_id text,p_actor_user_id text,p_rows jsonb)
returns jsonb language plpgsql as $$
declare v_row jsonb; v_id text; v_count integer:=0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 200 then raise exception 'bulk listing batch must contain 1-200 rows'; end if;
  if not exists(select 1 from merchant_accounts ma where ma.merchant_id=p_merchant_id and ma.user_id=p_actor_user_id and ma.status='active') then raise exception 'merchant access denied'; end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if coalesce(length(trim(v_row->>'name')),0) < 3 then raise exception 'invalid product name'; end if;
    if coalesce((v_row->>'price')::numeric,0) <= 0 then raise exception 'invalid product price'; end if;
    if coalesce((v_row->>'stock')::integer,-1) < 0 then raise exception 'invalid product stock'; end if;
    v_id:='prod_'||replace(gen_random_uuid()::text,'-','');
    insert into products(id,merchant_id,name,category,subcategory,listing_type,price,currency,stock,description,status,brand,model,sku)
    values(v_id,p_merchant_id,trim(v_row->>'name'),v_row->>'category',nullif(trim(coalesce(v_row->>'subcategory','')),''),coalesce(nullif(v_row->>'listingType',''),'product'),(v_row->>'price')::numeric,'GHS',(v_row->>'stock')::integer,left(coalesce(v_row->>'description',''),4000),'pending_review',nullif(trim(coalesce(v_row->>'brand','')),''),nullif(trim(coalesce(v_row->>'model','')),''),nullif(trim(coalesce(v_row->>'sku','')),''));
    v_count:=v_count+1;
  end loop;
  perform record_audit_event('merchant.product.bulk_created','merchant',p_merchant_id,p_actor_user_id,'merchant',null,'success',jsonb_build_object('count',v_count));
  return jsonb_build_object('created',v_count,'status','pending_review');
end;
$$;

create table if not exists marketplace_product_events (
  id text primary key,
  product_id text not null references products(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  event_type text not null check(event_type in ('view','add_to_cart')),
  created_at timestamptz not null default now()
);
create index if not exists marketplace_product_events_merchant_idx on marketplace_product_events(merchant_id,created_at desc,event_type);
comment on table marketplace_product_events is 'Privacy-minimized aggregate product funnel events. No customer id, IP address, device fingerprint, or external analytics provider identifier is stored.';

create or replace function merchant_product_funnel_snapshot(p_merchant_id text)
returns jsonb language sql stable as $$
with e as (
  select count(*) filter(where event_type='view')::int views,
         count(*) filter(where event_type='add_to_cart')::int adds
    from marketplace_product_events where merchant_id=p_merchant_id and created_at>=now()-interval '30 days'
), o as (
  select count(distinct oi.order_id)::int orders
    from order_items oi join products p on p.id=oi.product_id join orders ord on ord.id=oi.order_id
   where p.merchant_id=p_merchant_id and ord.created_at>=now()-interval '30 days' and ord.status not in ('cancelled','refunded')
)
select jsonb_build_object('windowDays',30,'views',e.views,'addToCarts',e.adds,'orders',o.orders,
  'viewToCartRate',case when e.views=0 then 0 else round(e.adds::numeric/e.views*100,2) end,
  'cartToOrderRate',case when e.adds=0 then 0 else round(o.orders::numeric/e.adds*100,2) end)
from e cross join o;
$$;
