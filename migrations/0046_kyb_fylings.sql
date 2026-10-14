-- Provider-neutral KYB storage and merchant application registration number.
-- Fylings remains an adapter and is not a domain dependency.
alter table merchant_applications
  add column if not exists registration_number text;
alter table merchant_applications
  add column if not exists updated_at timestamptz not null default now();

-- Provider-neutral KYB storage. Fylings is an adapter, not a domain dependency.
insert into merchant_verification_checks (id, application_id, check_type)
select 'mvc_'||replace(gen_random_uuid()::text,'-',''), ma.id, 'business'
from merchant_applications ma
where not exists (
  select 1 from merchant_verification_checks mvc
  where mvc.application_id=ma.id and mvc.check_type='business'
);

create index if not exists merchant_verification_checks_provider_idx
  on merchant_verification_checks(provider_key, provider_reference);

create or replace function review_merchant_application(
  p_application_id text,
  p_admin_id text,
  p_action text,
  p_reason text default null
) returns jsonb language plpgsql as $$
declare
  v_app record;
  v_new_status text;
  v_email_ok boolean;
  v_phone_ok boolean;
  v_business_ok boolean;
  v_merchant_id text;
begin
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then raise exception 'admin identity required'; end if;
  if p_action not in ('start_review','approve','reject') then raise exception 'invalid merchant review action'; end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:merchant-application:'||p_application_id, 0));
  select * into v_app from merchant_applications where id=p_application_id for update;
  if not found then raise exception 'merchant application not found'; end if;

  if p_action='start_review' then
    if v_app.status <> 'pending' then raise exception 'application is not pending'; end if;
    v_new_status := 'reviewing';
  elsif p_action='approve' then
    if v_app.status <> 'reviewing' then raise exception 'application must be under review'; end if;
    select exists(select 1 from merchant_verification_checks where application_id=v_app.id and check_type='email' and status='verified'),
           exists(select 1 from merchant_verification_checks where application_id=v_app.id and check_type='phone' and status='verified'),
           exists(select 1 from merchant_verification_checks where application_id=v_app.id and check_type='business' and status='verified')
      into v_email_ok, v_phone_ok, v_business_ok;
    if not v_email_ok or not v_phone_ok then raise exception 'email and phone verification are required before merchant approval'; end if;
    if not v_business_ok then raise exception 'business KYB verification is required before merchant approval'; end if;
    v_new_status := 'approved';
  else
    if v_app.status <> 'reviewing' then raise exception 'application must be under review'; end if;
    if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'rejection reason required'; end if;
    v_new_status := 'rejected';
  end if;

  update merchant_applications set status=v_new_status, updated_at=now() where id=v_app.id;

  if v_new_status='approved' then v_merchant_id := null; end if;

  perform record_audit_event(
    'merchant.application.'||v_new_status,
    'merchant_application', v_app.id, p_admin_id, 'admin', null, 'success',
    jsonb_build_object('action',p_action,'reason',nullif(trim(coalesce(p_reason,'')),''),'merchantId',v_merchant_id)
  );

  return jsonb_build_object('applicationId',v_app.id,'status',v_new_status,'merchantId',v_merchant_id);
end;
$$;
