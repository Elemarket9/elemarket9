-- Merchant approval activation: approved applications receive an explicit merchant
-- record + ownership membership atomically. Customer identity remains customer-role;
-- merchant access is carried by merchant_accounts.

create or replace function activate_approved_merchant_application(
  p_application_id text,
  p_admin_id text,
  p_lat double precision,
  p_lon double precision,
  p_city text,
  p_neighborhood text
) returns jsonb language plpgsql as $$
declare
  v_app record;
  v_existing text;
  v_merchant_id text;
  v_city text;
  v_neighborhood text;
begin
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then
    raise exception 'admin identity required';
  end if;
  if p_lat is null or p_lat < -90 or p_lat > 90 then raise exception 'valid merchant latitude required'; end if;
  if p_lon is null or p_lon < -180 or p_lon > 180 then raise exception 'valid merchant longitude required'; end if;
  if p_city is null or length(trim(p_city)) < 1 then raise exception 'merchant city required'; end if;
  if p_neighborhood is null or length(trim(p_neighborhood)) < 1 then raise exception 'merchant neighborhood required'; end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:merchant-application:'||p_application_id, 0));
  select * into v_app from merchant_applications where id=p_application_id for update;
  if not found then raise exception 'merchant application not found'; end if;
  if v_app.status <> 'approved' then raise exception 'merchant application must be approved before activation'; end if;

  select ma.merchant_id into v_existing
    from merchant_accounts ma
   where ma.user_id=v_app.user_id and ma.status='active'
   order by ma.created_at asc
   limit 1;
  if v_existing is not null then
    return jsonb_build_object('applicationId', v_app.id, 'merchantId', v_existing, 'activated', false, 'existing', true);
  end if;

  v_merchant_id := 'merch_'||replace(gen_random_uuid()::text,'-','');
  v_city := left(trim(p_city), 160);
  v_neighborhood := left(trim(p_neighborhood), 160);

  insert into merchants(
    id,name,category,status,verified,tier,description,address,city,neighborhood,lat,lon
  ) values (
    v_merchant_id,
    v_app.business_name,
    v_app.category,
    'active',
    true,
    'merchant',
    '',
    v_app.address,
    v_city,
    v_neighborhood,
    p_lat,
    p_lon
  );

  insert into merchant_accounts(merchant_id,user_id,status)
  values(v_merchant_id,v_app.user_id,'active');

  perform record_audit_event(
    'merchant.account.activated',
    'merchant_application',
    v_app.id,
    p_admin_id,
    'admin',
    null,
    'success',
    jsonb_build_object('merchantId',v_merchant_id,'userId',v_app.user_id)
  );

  return jsonb_build_object('applicationId',v_app.id,'merchantId',v_merchant_id,'activated',true,'existing',false);
end;
$$;
