-- v1.92 production admin campaign management.
alter table homepage_ad_campaigns
  add column if not exists cta_label text,
  add column if not exists target_category text,
  add column if not exists mobile_visible boolean not null default true,
  add column if not exists desktop_visible boolean not null default true,
  add column if not exists version integer not null default 1,
  add column if not exists admin_notes text,
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;

alter table homepage_ad_campaigns
  add constraint homepage_ad_cta_label_chk check (cta_label is null or char_length(trim(cta_label)) between 1 and 40);
alter table homepage_ad_campaigns
  add constraint homepage_ad_target_category_chk check (target_category is null or char_length(trim(target_category)) between 2 and 80);
alter table homepage_ad_campaigns
  add constraint homepage_ad_admin_notes_chk check (admin_notes is null or char_length(admin_notes) <= 2000);
alter table homepage_ad_campaigns
  add constraint homepage_ad_version_chk check (version >= 1);

create index if not exists homepage_ads_schedule_priority_idx
  on homepage_ad_campaigns(status, placement, starts_at, ends_at, priority, created_at desc);
create index if not exists homepage_ads_category_idx
  on homepage_ad_campaigns(target_category, placement, status, starts_at, ends_at);

-- Only approved, scheduled/active campaigns are public. Draft/rejected/paused/archived campaigns never render.
create or replace function validate_homepage_ad_campaign()
returns trigger language plpgsql as $$
declare
  v_merchant record;
  v_product record;
begin
  if new.ends_at <= new.starts_at then raise exception 'invalid homepage campaign window'; end if;
  if new.priority < 0 or new.priority > 10000 then raise exception 'invalid campaign priority'; end if;
  if new.max_impressions is not null and (new.max_impressions < 1 or new.max_impressions > 1000000000) then raise exception 'invalid impression cap'; end if;
  select status, verified into v_merchant from merchants where id=new.merchant_id;
  if not found or v_merchant.status <> 'active' or v_merchant.verified is not true then
    raise exception 'homepage advertising requires an active verified merchant';
  end if;
  if new.destination_type='product' then
    if new.product_id is null or new.destination_id <> new.product_id then raise exception 'product destination mismatch'; end if;
    select p.status,p.merchant_id,p.listing_type,p.stock,p.category into v_product from products p where p.id=new.product_id;
    if not found or v_product.merchant_id <> new.merchant_id or v_product.status <> 'active' then
      raise exception 'homepage campaign product is not an active merchant product';
    end if;
    if new.placement='food_spotlight' and (v_product.listing_type <> 'food' or v_product.stock <= 0) then
      raise exception 'food spotlight requires an active in-stock food listing';
    end if;
    if new.target_category is not null and lower(trim(new.target_category)) <> lower(trim(v_product.category)) then
      raise exception 'campaign category does not match product category';
    end if;
  elsif new.destination_type='merchant' then
    if new.destination_id <> new.merchant_id then raise exception 'merchant destination mismatch'; end if;
    if new.placement='food_spotlight' then raise exception 'food spotlight requires a product destination'; end if;
  elsif new.destination_type='category' then
    if new.product_id is not null then raise exception 'category campaigns cannot bind a product'; end if;
    if new.placement='food_spotlight' then raise exception 'food spotlight requires a product destination'; end if;
  else
    raise exception 'unsupported campaign destination';
  end if;
  if new.image_path is not null and new.image_path ~* '^(https?:|data:|javascript:|//)' then raise exception 'external campaign media is not allowed'; end if;
  if new.status='active' and (new.starts_at > now() or new.ends_at <= now()) then raise exception 'active campaign must be inside its schedule'; end if;
  if new.status='scheduled' and new.ends_at <= now() then raise exception 'scheduled campaign has expired'; end if;
  if new.status in ('active','scheduled') and new.reviewed_by is null then raise exception 'campaign must be reviewed before activation'; end if;
  return new;
end;
$$;

create or replace function admin_set_homepage_campaign_status(
  p_campaign_id text,
  p_action text,
  p_admin_id text,
  p_reason text default null,
  p_expected_version integer default null
) returns jsonb language plpgsql as $$
declare r homepage_ad_campaigns%rowtype; next_status text;
begin
  if p_action not in ('approve','pause','resume','reject','archive','end') then raise exception 'invalid campaign action'; end if;
  select * into r from homepage_ad_campaigns where id=p_campaign_id for update;
  if not found then raise exception 'campaign not found'; end if;
  if p_expected_version is not null and r.version <> p_expected_version then raise exception 'campaign changed; refresh and retry'; end if;
  if p_action='approve' then
    if r.status not in ('draft','pending_review','rejected') then raise exception 'campaign is not awaiting approval'; end if;
    next_status:=case when r.starts_at<=now() and r.ends_at>now() then 'active' else 'scheduled' end;
  elsif p_action='pause' then
    if r.status not in ('active','scheduled') then raise exception 'campaign cannot be paused from current state'; end if;
    next_status:='paused';
  elsif p_action='resume' then
    if r.status <> 'paused' then raise exception 'only paused campaigns can be resumed'; end if;
    next_status:=case when r.ends_at<=now() then 'ended' when r.starts_at<=now() then 'active' else 'scheduled' end;
  elsif p_action='reject' then
    if r.status not in ('draft','pending_review','scheduled','paused','rejected') then raise exception 'campaign cannot be rejected from current state'; end if;
    next_status:='rejected';
  elsif p_action='end' then
    if r.status not in ('active','scheduled','paused') then raise exception 'campaign cannot be ended from current state'; end if;
    next_status:='ended';
  else
    if r.status not in ('draft','pending_review','rejected','paused','ended') then raise exception 'campaign cannot be archived from current state'; end if;
    next_status:='archived';
  end if;
  if p_action in ('approve','resume') and r.placement='food_spotlight' then
    if r.product_id is null then raise exception 'food campaign requires a product'; end if;
  end if;
  update homepage_ad_campaigns set status=next_status, reviewed_by=case when p_action='approve' then p_admin_id else reviewed_by end,
    reviewed_at=case when p_action='approve' then now() else reviewed_at end,
    approved_by=case when p_action='approve' then p_admin_id else approved_by end,
    approved_at=case when p_action='approve' then now() else approved_at end,
    rejection_reason=case when p_action='reject' then left(trim(coalesce(p_reason,'')),1000) else rejection_reason end,
    updated_at=now(), version=version+1 where id=p_campaign_id;
  return jsonb_build_object('id',p_campaign_id,'status',next_status,'version',r.version+1);
end;
$$;
revoke all on function admin_set_homepage_campaign_status(text,text,text,text,integer) from public;
