-- v1.93 campaign production hardening.
-- Re-review material edits and atomically enforce impression caps.

create or replace function validate_homepage_ad_campaign()
returns trigger language plpgsql as $$
declare
  v_merchant record;
  v_product record;
begin
  if new.ends_at <= new.starts_at then raise exception 'invalid homepage campaign window'; end if;
  if new.priority < 0 or new.priority > 10000 then raise exception 'invalid campaign priority'; end if;
  if new.max_impressions is not null and (new.max_impressions < 1 or new.max_impressions > 1000000000) then raise exception 'invalid impression cap'; end if;
  if new.image_path is not null and new.image_path !~ '^/uploads/[A-Za-z0-9._/-]{1,480}$' then raise exception 'campaign media must be an approved local upload path'; end if;
  select status, verified into v_merchant from merchants where id=new.merchant_id;
  if not found or v_merchant.status <> 'active' or v_merchant.verified is not true then raise exception 'homepage advertising requires an active verified merchant'; end if;
  if new.destination_type='product' then
    if new.product_id is null or new.destination_id <> new.product_id then raise exception 'product destination mismatch'; end if;
    select p.status,p.merchant_id,p.listing_type,p.stock,p.category into v_product from products p where p.id=new.product_id;
    if not found or v_product.merchant_id <> new.merchant_id or v_product.status <> 'active' then raise exception 'homepage campaign product is not an active merchant product'; end if;
    if new.placement='food_spotlight' and (v_product.listing_type <> 'food' or v_product.stock <= 0) then raise exception 'food spotlight requires an active in-stock food listing'; end if;
    if new.target_category is not null and lower(trim(new.target_category)) <> lower(trim(v_product.category)) then raise exception 'campaign category does not match product category'; end if;
  elsif new.destination_type='merchant' then
    if new.destination_id <> new.merchant_id then raise exception 'merchant destination mismatch'; end if;
    if new.placement='food_spotlight' then raise exception 'food spotlight requires a product destination'; end if;
  elsif new.destination_type='category' then
    if new.product_id is not null then raise exception 'category campaigns cannot bind a product'; end if;
    if new.placement='food_spotlight' then raise exception 'food spotlight requires a product destination'; end if;
  else raise exception 'unsupported campaign destination'; end if;
  if new.status='active' and (new.starts_at > now() or new.ends_at <= now()) then raise exception 'active campaign must be inside its schedule'; end if;
  if new.status='scheduled' and new.ends_at <= now() then raise exception 'scheduled campaign has expired'; end if;
  if new.status in ('active','scheduled') and new.reviewed_by is null then raise exception 'campaign must be reviewed before activation'; end if;
  return new;
end;
$$;

-- Material edits to a previously reviewed campaign require fresh approval.
create or replace function reset_homepage_campaign_review_on_edit()
returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' and (
    new.merchant_id is distinct from old.merchant_id or new.product_id is distinct from old.product_id or
    new.title is distinct from old.title or new.subtitle is distinct from old.subtitle or new.image_path is distinct from old.image_path or
    new.cta_label is distinct from old.cta_label or new.destination_type is distinct from old.destination_type or new.destination_id is distinct from old.destination_id or
    new.placement is distinct from old.placement or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at or
    new.target_city is distinct from old.target_city or new.target_category is distinct from old.target_category or new.priority is distinct from old.priority
  ) and old.status in ('scheduled','paused','rejected','active') then
    new.status := 'pending_review';
    new.reviewed_by := null; new.reviewed_at := null; new.approved_by := null; new.approved_at := null; new.rejection_reason := null;
  end if;
  return new;
end;
$$;
drop trigger if exists homepage_ad_review_reset on homepage_ad_campaigns;
create trigger homepage_ad_review_reset before update on homepage_ad_campaigns
for each row execute function reset_homepage_campaign_review_on_edit();

create or replace function record_homepage_ad_event(
  p_event_id text, p_campaign_id text, p_event_type text, p_session_key text
) returns jsonb language plpgsql as $$
declare
  v_inserted boolean := false; v_count bigint := 0; v_cap bigint;
begin
  if p_event_id !~ '^[A-Za-z0-9_-]{16,128}$' then raise exception 'invalid ad event id'; end if;
  if p_session_key !~ '^[A-Za-z0-9_-]{32,128}$' then raise exception 'invalid ad visitor'; end if;
  if p_event_type not in ('impression','click') then raise exception 'invalid ad event type'; end if;
  select max_impressions into v_cap from homepage_ad_campaigns where id=p_campaign_id and status='active' and starts_at<=now() and ends_at>now() for update;
  if not found then return jsonb_build_object('recorded',false); end if;
  if p_event_type='impression' and v_cap is not null then
    if not exists(select 1 from homepage_ad_campaigns where id=p_campaign_id and impression_count < v_cap) then return jsonb_build_object('recorded',false,'reason','impression_cap_reached'); end if;
  end if;
  insert into homepage_ad_events(id,campaign_id,event_type,session_key) values(p_event_id,p_campaign_id,p_event_type,p_session_key)
    on conflict (campaign_id,event_type,session_key) do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted and p_event_type='impression' then
    update homepage_ad_campaigns set impression_count=impression_count+1,updated_at=now() where id=p_campaign_id and (max_impressions is null or impression_count < max_impressions);
    if not found then delete from homepage_ad_events where id=p_event_id; return jsonb_build_object('recorded',false,'reason','impression_cap_reached'); end if;
  elsif v_inserted then
    update homepage_ad_campaigns set click_count=click_count+1,updated_at=now() where id=p_campaign_id;
  end if;
  select case when p_event_type='impression' then impression_count else click_count end into v_count from homepage_ad_campaigns where id=p_campaign_id;
  return jsonb_build_object('recorded',v_inserted,'count',coalesce(v_count,0));
end;
$$;
revoke all on function record_homepage_ad_event(text,text,text,text) from public;
