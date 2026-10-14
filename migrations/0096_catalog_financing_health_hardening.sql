-- v1.66: Walmart-grade catalog integrity + financing-health terminology hardening.
-- Catalog taxonomy is authoritative at the database boundary. Merchant Health remains
-- a marketplace-performance signal; it is never a credit decision or approval tier.

-- -----------------------------------------------------------------------------
-- Canonical taxonomy: reject invalid/inactive categories and mismatched subcategories
-- for every writer, including enterprise catalog ingestion.
-- -----------------------------------------------------------------------------
create or replace function validate_product_taxonomy()
returns trigger language plpgsql as $$
declare
  v_category_active boolean;
  v_subcategory_active boolean;
begin
  select active into v_category_active
    from category_taxonomy
   where category_key = new.category;

  if coalesce(v_category_active, false) is not true then
    raise exception 'invalid or inactive product category';
  end if;

  if new.subcategory is not null then
    select active into v_subcategory_active
      from category_subcategories
     where category_key = new.category
       and subcategory_key = new.subcategory;
    if coalesce(v_subcategory_active, false) is not true then
      raise exception 'invalid or inactive product subcategory for category';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists products_taxonomy_validate on products;
create trigger products_taxonomy_validate
before insert or update of category, subcategory on products
for each row execute function validate_product_taxonomy();

-- -----------------------------------------------------------------------------
-- Catalog quality read model. This is a merchandising/listing-health signal,
-- separate from Merchant Health and never used as a credit decision.
-- -----------------------------------------------------------------------------
create table if not exists product_listing_quality (
  product_id text primary key references products(id) on delete cascade,
  score integer not null check (score between 0 and 100),
  content_score integer not null check (content_score between 0 and 100),
  discoverability_score integer not null check (discoverability_score between 0 and 100),
  offer_score integer not null check (offer_score between 0 and 100),
  availability_score integer not null check (availability_score between 0 and 100),
  customer_signal_score integer not null check (customer_signal_score between 0 and 100),
  calculated_at timestamptz not null default now(),
  model_version text not null default 'listing-quality-v1'
);
create index if not exists product_listing_quality_score_idx
  on product_listing_quality(score desc, calculated_at desc);
create index if not exists product_listing_quality_product_idx
  on product_listing_quality(product_id);

create or replace function calculate_product_listing_quality(p_product_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p record;
  v_content integer;
  v_discoverability integer;
  v_offer integer;
  v_availability integer;
  v_customer integer;
  v_score integer;
begin
  select * into p from products where id=p_product_id;
  if not found then raise exception 'product not found'; end if;

  v_content := least(100,
    (case when length(btrim(coalesce(p.name,''))) >= 8 then 20 else 0 end) +
    (case when length(btrim(coalesce(p.description,''))) >= 80 then 20 else 0 end) +
    (case when p.image_path is not null and length(btrim(p.image_path)) > 0 then 20 else 0 end) +
    (case when p.brand is not null and length(btrim(p.brand)) > 0 then 10 else 0 end) +
    (case when p.model is not null and length(btrim(p.model)) > 0 then 10 else 0 end) +
    (case when jsonb_typeof(coalesce(p.attributes,'{}'::jsonb))='object' and jsonb_object_length(coalesce(p.attributes,'{}'::jsonb)) >= 2 then 20 else 0 end)
  );

  v_discoverability := least(100,
    (case when p.category is not null then 25 else 0 end) +
    (case when p.subcategory is not null then 25 else 0 end) +
    (case when p.sku is not null and length(btrim(p.sku)) > 0 then 15 else 0 end) +
    (case when p.brand is not null and length(btrim(p.brand)) > 0 then 15 else 0 end) +
    (case when p.status='active' then 20 else 0 end)
  );

  v_offer := least(100,
    (case when p.price > 0 then 35 else 0 end) +
    (case when p.returnable then 20 else 10 end) +
    (case when coalesce(p.return_window_days,0) > 0 then 15 else 0 end) +
    (case when p.fulfillment_type is not null then 15 else 0 end) +
    (case when p.condition is not null then 15 else 0 end)
  );

  v_availability := case
    when p.status <> 'active' then 0
    when coalesce(p.stock,0) <= 0 then 25
    when p.stock >= 10 then 100
    else 50 + least(50, p.stock * 5)
  end;

  select least(100, greatest(0,
    50 + round((coalesce(avg(r.rating),0) - 3.0) * 25)::int
  )) into v_customer
    from reviews r
   where r.product_id=p_product_id;

  v_score := round(
    v_content * 0.30 +
    v_discoverability * 0.20 +
    v_offer * 0.20 +
    v_availability * 0.15 +
    v_customer * 0.15
  );

  insert into product_listing_quality(
    product_id,score,content_score,discoverability_score,offer_score,
    availability_score,customer_signal_score,calculated_at,model_version
  ) values (
    p_product_id,v_score,v_content,v_discoverability,v_offer,
    v_availability,v_customer,now(),'listing-quality-v1'
  ) on conflict (product_id) do update set
    score=excluded.score,content_score=excluded.content_score,
    discoverability_score=excluded.discoverability_score,offer_score=excluded.offer_score,
    availability_score=excluded.availability_score,customer_signal_score=excluded.customer_signal_score,
    calculated_at=excluded.calculated_at,model_version=excluded.model_version;

  return jsonb_build_object(
    'score',v_score,'contentScore',v_content,'discoverabilityScore',v_discoverability,
    'offerScore',v_offer,'availabilityScore',v_availability,'customerSignalScore',v_customer,
    'modelVersion','listing-quality-v1','calculatedAt',now()
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Merchant Health: neutral health bands only. Existing scores are preserved;
-- band names are recalculated from the numeric score.
-- -----------------------------------------------------------------------------
update merchant_scores
   set band = case when score < 400 then 'limited_history'
                   when score < 550 then 'developing'
                   when score < 700 then 'established'
                   when score < 850 then 'strong'
                   else 'very_strong' end;

update merchant_score_history
   set band = case when score < 400 then 'limited_history'
                   when score < 550 then 'developing'
                   when score < 700 then 'established'
                   when score < 850 then 'strong'
                   else 'very_strong' end;

alter table merchant_scores drop constraint if exists merchant_scores_band_check;
alter table merchant_scores add constraint merchant_scores_band_check
  check (band in ('limited_history','developing','established','strong','very_strong')) not valid;

alter table merchant_score_history drop constraint if exists merchant_score_history_band_check;
alter table merchant_score_history add constraint merchant_score_history_band_check
  check (band in ('limited_history','developing','established','strong','very_strong')) not valid;

create or replace function merchant_health_band(p_score integer)
returns text language plpgsql immutable as $$
begin
  return case
    when p_score < 400 then 'limited_history'
    when p_score < 550 then 'developing'
    when p_score < 700 then 'established'
    when p_score < 850 then 'strong'
    else 'very_strong'
  end;
end;
$$;

create or replace function validate_merchant_score_band()
returns trigger language plpgsql as $$
declare expected text;
begin
  expected := merchant_health_band(new.score);
  if new.band <> expected then
    raise exception 'merchant health band does not match score';
  end if;
  return new;
end;
$$;

comment on column merchant_scores.band is
  'Neutral marketplace-health band. Never a credit approval, lending eligibility, or recommended loan amount.';
comment on column merchant_financing_applications.score_snapshot is
  'Immutable-at-application marketplace health signal snapshot; financing provider makes its own underwriting decision.';
