-- v1.99.9 financing provider governance and operational safety.
-- Financing remains provider-led: ELEMARKET orchestrates marketplace access and consent,
-- while external providers make credit decisions, price credit and fund approved facilities.

alter table financing_providers
  add column if not exists marketplace_enabled boolean not null default false,
  add column if not exists regulatory_status text not null default 'pending'
    check (regulatory_status in ('pending','verified','suspended','not_required')),
  add column if not exists regulatory_reference text,
  add column if not exists regulated_entity_name text,
  add column if not exists country_code char(2) not null default 'GH',
  add column if not exists currency char(3) not null default 'GHS',
  add column if not exists minimum_application_amount numeric(12,2),
  add column if not exists maximum_application_amount numeric(12,2),
  add column if not exists terms_url text,
  add column if not exists privacy_url text,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by_user_id text;

alter table financing_providers drop constraint if exists financing_providers_amount_range_check;
alter table financing_providers add constraint financing_providers_amount_range_check check (
  (minimum_application_amount is null or minimum_application_amount > 0)
  and (maximum_application_amount is null or maximum_application_amount > 0)
  and (minimum_application_amount is null or maximum_application_amount is null or minimum_application_amount <= maximum_application_amount)
) not valid;

create or replace function validate_financing_provider_governance()
returns trigger language plpgsql as $$
begin
  if new.marketplace_enabled then
    if new.status <> 'active' then raise exception 'enabled financing provider must be active'; end if;
    if new.regulatory_status not in ('verified','not_required') then raise exception 'enabled financing provider requires regulatory/compliance verification'; end if;
    if new.regulated_entity_name is null or length(btrim(new.regulated_entity_name)) < 2 then raise exception 'enabled financing provider requires regulated entity name'; end if;
    if new.regulatory_status='verified' and (new.regulatory_reference is null or length(btrim(new.regulatory_reference)) < 2) then
      raise exception 'verified financing provider requires regulatory reference';
    end if;
    if new.terms_url is null or new.terms_url !~* '^https://[^[:space:]]+$' then raise exception 'enabled financing provider requires HTTPS terms URL'; end if;
    if new.privacy_url is null or new.privacy_url !~* '^https://[^[:space:]]+$' then raise exception 'enabled financing provider requires HTTPS privacy URL'; end if;
    if new.integration_mode='partner_handoff' and (new.application_url is null or new.application_url !~* '^https://[^[:space:]]+$') then
      raise exception 'partner handoff financing provider requires HTTPS application URL';
    end if;
  end if;
  if new.country_code !~ '^[A-Z]{2}$' then raise exception 'invalid financing provider country code'; end if;
  if new.currency !~ '^[A-Z]{3}$' then raise exception 'invalid financing provider currency'; end if;
  return new;
end;
$$;

drop trigger if exists financing_provider_governance_validate on financing_providers;
create trigger financing_provider_governance_validate
before insert or update on financing_providers
for each row execute function validate_financing_provider_governance();

create index if not exists financing_providers_live_idx
  on financing_providers(audience,product_type,currency,status,marketplace_enabled,regulatory_status);

-- Existing rows remain disabled until an administrator records the actual partner and
-- regulatory/commercial verification. This prevents development seed rows from becoming live credit offers.
update financing_providers set marketplace_enabled=false where marketplace_enabled is distinct from false;

-- Provider-facing health tokens are high-sensitivity delegated credentials. Require an
-- explicit maximum lifetime so a forgotten grant cannot remain valid forever.
alter table merchant_financing_provider_access
  add column if not exists last_used_at timestamptz;

create or replace function validate_merchant_financing_provider_access_expiry()
returns trigger language plpgsql as $$
begin
  if new.expires_at is null then raise exception 'merchant health provider access expiry is required'; end if;
  if new.expires_at <= now() then raise exception 'merchant health provider access expiry must be in the future'; end if;
  if new.expires_at > now() + interval '90 days' then raise exception 'merchant health provider access may not exceed 90 days'; end if;
  return new;
end;
$$;

drop trigger if exists merchant_financing_provider_access_expiry_validate on merchant_financing_provider_access;
create trigger merchant_financing_provider_access_expiry_validate
before insert or update of expires_at on merchant_financing_provider_access
for each row execute function validate_merchant_financing_provider_access_expiry();

comment on column financing_providers.marketplace_enabled is
  'Explicit ELEMARKET operational switch. Active status alone never exposes a financing provider to customers or merchants.';
comment on column financing_providers.regulatory_status is
  'Recorded marketplace due-diligence state only. ELEMARKET does not issue credit approval or substitute for the provider regulator.';
comment on column financing_providers.regulatory_reference is
  'Reference/evidence recorded during provider due diligence. Never interpreted as an ELEMARKET lending licence.';

create or replace function validate_live_financing_application_provider()
returns trigger language plpgsql as $$
declare
  v record;
  v_amount numeric;
begin
  select audience,product_type,status,marketplace_enabled,regulatory_status,currency,
         minimum_application_amount,maximum_application_amount
    into v from financing_providers where id=new.provider_id;
  if not found then raise exception 'financing provider not found'; end if;
  if v.status <> 'active' or v.marketplace_enabled is not true or v.regulatory_status not in ('verified','not_required') then
    raise exception 'financing provider is not enabled for marketplace applications';
  end if;
  if tg_table_name='customer_financing_applications' then
    if v.audience <> 'customer' or v.product_type not in ('bnpl','installment') then raise exception 'provider is not enabled for customer financing'; end if;
    v_amount := new.amount;
  else
    if v.audience <> 'merchant' or v.product_type not in ('merchant_cash_advance','line_of_credit','term_loan') then raise exception 'provider is not enabled for merchant financing'; end if;
    v_amount := new.requested_amount;
  end if;
  if new.currency <> v.currency then raise exception 'financing application currency does not match provider'; end if;
  if v.minimum_application_amount is not null and v_amount < v.minimum_application_amount then raise exception 'financing amount below provider minimum'; end if;
  if v.maximum_application_amount is not null and v_amount > v.maximum_application_amount then raise exception 'financing amount above provider maximum'; end if;
  return new;
end;
$$;

drop trigger if exists customer_financing_live_provider_validate on customer_financing_applications;
create trigger customer_financing_live_provider_validate
before insert or update of provider_id,amount,currency on customer_financing_applications
for each row execute function validate_live_financing_application_provider();

drop trigger if exists merchant_financing_live_provider_validate on merchant_financing_applications;
create trigger merchant_financing_live_provider_validate
before insert or update of provider_id,requested_amount,currency on merchant_financing_applications
for each row execute function validate_live_financing_application_provider();

-- Snapshot provider integration semantics on the application itself. This fixes the
-- historical replay query that expected customer_financing_applications.integration_mode
-- and prevents later provider reconfiguration from changing an existing application's meaning.
alter table customer_financing_applications add column if not exists integration_mode text;
alter table merchant_financing_applications add column if not exists integration_mode text;

update customer_financing_applications a set integration_mode=p.integration_mode
  from financing_providers p where p.id=a.provider_id and a.integration_mode is null;
update merchant_financing_applications a set integration_mode=p.integration_mode,
       redirect_url=case when p.integration_mode='partner_handoff' then coalesce(a.redirect_url,p.application_url) else a.redirect_url end
  from financing_providers p where p.id=a.provider_id and a.integration_mode is null;

alter table customer_financing_applications drop constraint if exists customer_financing_integration_mode_check;
alter table customer_financing_applications add constraint customer_financing_integration_mode_check
  check (integration_mode is null or integration_mode in ('api','partner_handoff','manual_review')) not valid;
alter table merchant_financing_applications drop constraint if exists merchant_financing_integration_mode_check;
alter table merchant_financing_applications add constraint merchant_financing_integration_mode_check
  check (integration_mode is null or integration_mode in ('api','partner_handoff','manual_review')) not valid;

create or replace function snapshot_financing_provider_integration()
returns trigger language plpgsql as $$
declare v record;
begin
  select integration_mode,application_url into v from financing_providers where id=new.provider_id;
  if not found then raise exception 'financing provider not found'; end if;
  new.integration_mode := v.integration_mode;
  if v.integration_mode='partner_handoff' and new.redirect_url is null then new.redirect_url := v.application_url; end if;
  return new;
end;
$$;

drop trigger if exists customer_financing_integration_snapshot on customer_financing_applications;
create trigger customer_financing_integration_snapshot
before insert or update of provider_id on customer_financing_applications
for each row execute function snapshot_financing_provider_integration();

drop trigger if exists merchant_financing_integration_snapshot on merchant_financing_applications;
create trigger merchant_financing_integration_snapshot
before insert or update of provider_id on merchant_financing_applications
for each row execute function snapshot_financing_provider_integration();
