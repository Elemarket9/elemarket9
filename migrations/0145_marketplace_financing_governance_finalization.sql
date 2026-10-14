-- V2006: finalize financing as marketplace orchestration, not regulator/lender governance.
-- Historical regulatory_* columns from 0140 remain for migration compatibility only and are
-- intentionally excluded from active provider eligibility decisions.

alter table financing_providers
  add column if not exists provider_legal_name text;

update financing_providers
   set provider_legal_name=coalesce(nullif(btrim(regulated_entity_name),''),nullif(btrim(name),''))
 where provider_legal_name is null;

create or replace function validate_financing_provider_governance()
returns trigger language plpgsql as $$
begin
  if new.marketplace_enabled then
    if new.status <> 'active' then raise exception 'enabled financing provider must be active'; end if;
    if new.marketplace_partner_status <> 'active' then raise exception 'enabled financing provider requires active marketplace partnership'; end if;
    if new.security_review_status not in ('passed','waived') then raise exception 'enabled financing provider requires ELEMARKET security review'; end if;
    if new.integration_status <> 'ready' then raise exception 'enabled financing provider integration must be ready'; end if;
    if new.commercial_status <> 'active' then raise exception 'enabled financing provider commercial relationship must be active'; end if;
    if new.customer_channel_enabled is not true then raise exception 'enabled financing provider marketplace channel must be enabled'; end if;
    if new.provider_legal_name is null or length(btrim(new.provider_legal_name)) < 2 then raise exception 'enabled financing provider requires provider legal/business name'; end if;
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

create or replace function validate_live_financing_application_provider()
returns trigger language plpgsql as $$
declare
  v record;
  v_amount numeric;
begin
  select audience,product_type,status,marketplace_enabled,marketplace_partner_status,
         security_review_status,integration_status,commercial_status,customer_channel_enabled,
         currency,minimum_application_amount,maximum_application_amount
    into v from financing_providers where id=new.provider_id;
  if not found then raise exception 'financing provider not found'; end if;
  if v.status <> 'active' or v.marketplace_enabled is not true
     or v.marketplace_partner_status <> 'active'
     or v.security_review_status not in ('passed','waived')
     or v.integration_status <> 'ready'
     or v.commercial_status <> 'active'
     or v.customer_channel_enabled is not true then
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

drop index if exists financing_providers_live_idx;
create index if not exists financing_providers_marketplace_live_idx
  on financing_providers(audience,product_type,currency,status,marketplace_enabled,
                         marketplace_partner_status,security_review_status,integration_status,
                         commercial_status,customer_channel_enabled);

comment on column financing_providers.regulatory_status is
 'Legacy compatibility field retained from migration 0140. Not used by ELEMARKET to certify, license, approve or expose financing providers.';
comment on column financing_providers.regulatory_reference is
 'Legacy compatibility metadata retained from migration 0140. Not an ELEMARKET certification and not used for provider eligibility.';
comment on column financing_providers.provider_legal_name is
 'Provider-supplied legal/business identity shown for marketplace transparency; not an ELEMARKET licensing determination.';
