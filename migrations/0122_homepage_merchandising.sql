-- v1.91 homepage merchandising engine.
-- Server-controlled merchandising; no arbitrary HTML, scripts, or external URLs.
create table if not exists homepage_sections (
  section_key text primary key check (section_key ~ '^[a-z][a-z0-9_]{1,48}$'),
  title text not null check (char_length(trim(title)) between 2 and 100),
  eyebrow text check (eyebrow is null or char_length(trim(eyebrow)) between 2 and 60),
  priority integer not null default 100 check (priority between 0 and 10000),
  active boolean not null default true,
  max_items integer not null default 8 check (max_items between 1 and 20),
  mobile_visible boolean not null default true,
  desktop_visible boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now()
);

insert into homepage_sections(section_key,title,eyebrow,priority,max_items)
values
 ('flash_sales','Flash Sales','Limited time',20,8),
 ('sponsored_ads','Sponsored','Featured offers',30,6),
 ('new_arrivals','New Arrivals','Just added',40,8),
 ('food_spotlight','Food Spotlight','Featured food',50,8),
 ('top_sellers','Top Sellers','Popular now',60,8),
 ('deals','Deals You Don''t Want to Miss','Deals',70,8),
 ('official_stores','Official & Verified Stores','Trusted sellers',80,6)
on conflict(section_key) do nothing;

create table if not exists homepage_ad_campaigns (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  product_id text references products(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 2 and 120),
  title text not null check (char_length(trim(title)) between 2 and 120),
  subtitle text check (subtitle is null or char_length(trim(subtitle)) <= 180),
  image_path text check (image_path is null or (char_length(image_path) between 1 and 500 and image_path !~* '^(https?:|data:|javascript:|//)')),
  destination_type text not null check (destination_type in ('product','merchant','category')),
  destination_id text not null check (char_length(trim(destination_id)) between 1 and 128),
  placement text not null default 'sponsored_ads' check (placement in ('sponsored_ads','food_spotlight')),
  status text not null default 'draft' check (status in ('draft','pending_review','scheduled','active','paused','ended','rejected','archived')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  target_city text check (target_city is null or char_length(trim(target_city)) between 2 and 80),
  priority integer not null default 100 check (priority between 0 and 10000),
  max_impressions bigint check (max_impressions is null or max_impressions between 1 and 1000000000),
  impression_count bigint not null default 0 check (impression_count >= 0),
  click_count bigint not null default 0 check (click_count >= 0),
  created_by text not null,
  reviewed_by text,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((placement='food_spotlight' and product_id is not null) or placement='sponsored_ads')
);
create index if not exists homepage_ads_active_idx on homepage_ad_campaigns(placement,status,starts_at,ends_at,priority);
create index if not exists homepage_ads_merchant_idx on homepage_ad_campaigns(merchant_id,status,starts_at,ends_at);
create index if not exists homepage_ads_city_idx on homepage_ad_campaigns(target_city,placement,status,starts_at,ends_at);

create or replace function validate_homepage_ad_campaign()
returns trigger language plpgsql as $$
declare
  v_merchant record;
  v_product record;
begin
  select status, verified into v_merchant from merchants where id=new.merchant_id;
  if not found or v_merchant.status <> 'active' or v_merchant.verified is not true then
    raise exception 'homepage advertising requires an active verified merchant';
  end if;
  if new.ends_at <= new.starts_at then raise exception 'invalid homepage campaign window'; end if;
  if new.destination_type='product' then
    if new.product_id is null or new.destination_id <> new.product_id then raise exception 'product destination mismatch'; end if;
    select p.status,p.merchant_id,p.listing_type,p.stock into v_product from products p where p.id=new.product_id;
    if not found or v_product.merchant_id <> new.merchant_id or v_product.status <> 'active' then
      raise exception 'homepage campaign product is not an active merchant product';
    end if;
    if new.placement='food_spotlight' and (v_product.listing_type <> 'food' or v_product.stock <= 0) then
      raise exception 'food spotlight requires an active in-stock food listing';
    end if;
  elsif new.destination_type='merchant' then
    if new.destination_id <> new.merchant_id then raise exception 'merchant destination mismatch'; end if;
  elsif new.destination_type='category' then
    if new.product_id is not null then raise exception 'category campaigns cannot bind a product'; end if;
  end if;
  if new.image_path is not null and new.image_path ~* '^(https?:|data:|javascript:|//)' then raise exception 'external campaign media is not allowed'; end if;
  if new.status='active' and (new.starts_at > now() or new.ends_at <= now()) then raise exception 'active campaign must be inside its schedule'; end if;
  if new.status='scheduled' and new.ends_at <= now() then raise exception 'scheduled campaign has expired'; end if;
  return new;
end;
$$;

drop trigger if exists homepage_ad_integrity on homepage_ad_campaigns;
create trigger homepage_ad_integrity before insert or update on homepage_ad_campaigns
for each row execute function validate_homepage_ad_campaign();

create table if not exists homepage_ad_events (
  id text primary key,
  campaign_id text not null references homepage_ad_campaigns(id) on delete cascade,
  event_type text not null check (event_type in ('impression','click')),
  session_key text not null check (char_length(session_key) between 16 and 128),
  created_at timestamptz not null default now()
);
create unique index if not exists homepage_ad_event_dedupe_idx on homepage_ad_events(campaign_id,event_type,session_key);
create index if not exists homepage_ad_events_campaign_idx on homepage_ad_events(campaign_id,created_at desc);

create or replace function record_homepage_ad_event(
  p_event_id text,
  p_campaign_id text,
  p_event_type text,
  p_session_key text
) returns jsonb language plpgsql as $$
declare v_inserted boolean := false; v_count bigint;
begin
  if p_event_id !~ '^[A-Za-z0-9_-]{16,128}$' then raise exception 'invalid ad event id'; end if;
  if p_session_key !~ '^[A-Za-z0-9_-]{16,128}$' then raise exception 'invalid ad session'; end if;
  if p_event_type not in ('impression','click') then raise exception 'invalid ad event type'; end if;
  insert into homepage_ad_events(id,campaign_id,event_type,session_key)
  select p_event_id,p_campaign_id,p_event_type,p_session_key
  where exists(select 1 from homepage_ad_campaigns c where c.id=p_campaign_id and c.status='active' and c.starts_at<=now() and c.ends_at>now())
  on conflict (campaign_id,event_type,session_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted then
    if p_event_type='impression' then
      update homepage_ad_campaigns set impression_count=impression_count+1,updated_at=now() where id=p_campaign_id;
    else
      update homepage_ad_campaigns set click_count=click_count+1,updated_at=now() where id=p_campaign_id;
    end if;
  end if;
  select count(*) into v_count from homepage_ad_events where campaign_id=p_campaign_id and event_type=p_event_type;
  return jsonb_build_object('recorded',v_inserted,'count',v_count);
end;
$$;

revoke all on function record_homepage_ad_event(text,text,text,text) from public;

comment on table homepage_ad_campaigns is 'Server-authoritative homepage sponsored campaigns; no arbitrary HTML/scripts/external media URLs.';
comment on table homepage_ad_events is 'Deduplicated campaign impression/click events.';
