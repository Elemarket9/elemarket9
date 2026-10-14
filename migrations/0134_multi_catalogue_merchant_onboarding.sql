-- v1.134: multi-catalogue merchant onboarding without breaking legacy primary-category contracts.
-- `category` remains the backward-compatible primary category. `catalog_categories`
-- is the authoritative declared catalogue scope for onboarding/profile surfaces.

alter table merchant_applications
  add column if not exists catalog_categories text[] not null default '{}'::text[];

update merchant_applications
   set catalog_categories = array[category]
 where cardinality(catalog_categories) = 0;

alter table merchants
  add column if not exists catalog_categories text[] not null default '{}'::text[];

update merchants
   set catalog_categories = array[category]
 where cardinality(catalog_categories) = 0;

alter table merchant_applications drop constraint if exists merchant_applications_catalog_categories_check;
alter table merchant_applications add constraint merchant_applications_catalog_categories_check check (
  cardinality(catalog_categories) between 1 and 19
  and category = catalog_categories[1]
  and catalog_categories <@ array[
    'food','restaurants','groceries','electronics','fashion','beauty','home','agriculture','automotive','health',
    'hospitality','baby-kids','books-media','sports','office','industrial-machinery','construction','pets','services'
  ]::text[]
);

alter table merchants drop constraint if exists merchants_catalog_categories_check;
alter table merchants add constraint merchants_catalog_categories_check check (
  cardinality(catalog_categories) between 1 and 19
  and category = catalog_categories[1]
  and catalog_categories <@ array[
    'food','restaurants','groceries','electronics','fashion','beauty','home','agriculture','automotive','health',
    'hospitality','baby-kids','books-media','sports','office','industrial-machinery','construction','pets','services'
  ]::text[]
);

create or replace function approve_and_activate_merchant_application(
  p_application_id text,
  p_admin_id text,
  p_lat double precision,
  p_lon double precision,
  p_city text,
  p_neighborhood text
) returns jsonb language plpgsql as $$
declare
  v_app record;
  v_email_ok boolean;
  v_phone_ok boolean;
  v_business_status text;
  v_existing text;
  v_merchant_id text;
begin
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then raise exception 'admin identity required'; end if;
  if p_lat is null or p_lat < -90 or p_lat > 90 then raise exception 'valid merchant latitude required'; end if;
  if p_lon is null or p_lon < -180 or p_lon > 180 then raise exception 'valid merchant longitude required'; end if;
  if p_city is null or length(trim(p_city)) < 1 then raise exception 'merchant city required'; end if;
  if p_neighborhood is null or length(trim(p_neighborhood)) < 1 then raise exception 'merchant neighborhood required'; end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:merchant-application:'||p_application_id, 0));
  select * into v_app from merchant_applications where id=p_application_id for update;
  if not found then raise exception 'merchant application not found'; end if;
  if v_app.status not in ('pending','reviewing','approved') then raise exception 'application cannot be approved from its current state'; end if;

  select exists(select 1 from merchant_verification_checks where application_id=v_app.id and check_type='email' and status='verified'),
         exists(select 1 from merchant_verification_checks where application_id=v_app.id and check_type='phone' and status='verified'),
         (select status from merchant_verification_checks where application_id=v_app.id and check_type='business' order by updated_at desc nulls last, created_at desc limit 1)
    into v_email_ok, v_phone_ok, v_business_status;
  if not v_email_ok or not v_phone_ok then raise exception 'email and phone verification are required before merchant approval'; end if;

  select ma.merchant_id into v_existing
    from merchant_accounts ma where ma.user_id=v_app.user_id and ma.status='active'
    order by ma.created_at asc limit 1;

  if v_existing is null then
    v_merchant_id := 'merch_'||replace(gen_random_uuid()::text,'-','');
    insert into merchants(id,name,category,catalog_categories,status,verified,tier,description,address,city,neighborhood,lat,lon)
    values(v_merchant_id,v_app.business_name,v_app.category,v_app.catalog_categories,'active',true,'merchant','',v_app.address,left(trim(p_city),160),left(trim(p_neighborhood),160),p_lat,p_lon);
    insert into merchant_accounts(merchant_id,user_id,status) values(v_merchant_id,v_app.user_id,'active');
  else
    v_merchant_id := v_existing;
  end if;

  update merchant_applications set status='approved', merchant_id=v_merchant_id, updated_at=now() where id=v_app.id;
  perform record_audit_event('merchant.application.approved','merchant_application',v_app.id,p_admin_id,'admin',null,'success',
    jsonb_build_object('merchantId',v_merchant_id,'manualApproval',true,'catalogCategories',v_app.catalog_categories,'automatedBusinessVerificationStatus',v_business_status));
  perform record_audit_event('merchant.account.activated','merchant_application',v_app.id,p_admin_id,'admin',null,'success',
    jsonb_build_object('merchantId',v_merchant_id,'userId',v_app.user_id));
  return jsonb_build_object('applicationId',v_app.id,'status','approved','merchantId',v_merchant_id,'activated',v_existing is null,'manualApproval',true,'catalogCategories',v_app.catalog_categories,'automatedBusinessVerificationStatus',v_business_status);
end;
$$;

comment on column merchant_applications.catalog_categories is
  'Canonical marketplace catalogue categories selected during merchant onboarding; category is retained as the primary legacy category.';
comment on column merchants.catalog_categories is
  'Canonical catalogue categories declared for the merchant; product-level taxonomy remains independently validated.';
