-- Financing partner marketplace-governance controls only.
-- ELEMARKET governs access to its marketplace; providers remain responsible for licensing,
-- underwriting, lending compliance, regulatory reporting, collections and lender obligations.

alter table financing_providers add column if not exists marketplace_partner_status text not null default 'review'
 check(marketplace_partner_status in ('review','active','suspended','terminated'));
alter table financing_providers add column if not exists security_review_status text not null default 'pending'
 check(security_review_status in ('pending','passed','failed','waived'));
alter table financing_providers add column if not exists integration_status text not null default 'pending'
 check(integration_status in ('pending','testing','ready','degraded','disabled'));
alter table financing_providers add column if not exists commercial_status text not null default 'pending'
 check(commercial_status in ('pending','active','paused','ended'));
alter table financing_providers add column if not exists customer_channel_enabled boolean not null default false;
alter table financing_providers add column if not exists provider_supplied_reference text;
alter table financing_providers add column if not exists suspension_reason text;
alter table financing_providers add column if not exists suspended_at timestamptz;
alter table financing_providers add column if not exists suspended_by_user_id text;

create table if not exists financing_marketplace_consents (
 id text primary key,
 organization_id text not null references partner_organizations(id) on delete cascade,
 provider_id text not null references financing_providers(id),
 application_audience text not null check(application_audience in ('customer','merchant')),
 application_id text not null,
 subject_user_id text,
 purpose text not null check(purpose in ('application_processing','provider_data_sharing')),
 consent_version text not null,
 consent_method text not null check(consent_method in ('electronic','oral','print')),
 consented_at timestamptz not null,
 revoked_at timestamptz,
 evidence_hash text not null check(evidence_hash ~ '^[a-f0-9]{64}$'),
 metadata jsonb not null default '{}'::jsonb check(jsonb_typeof(metadata)='object'),
 unique(provider_id,application_audience,application_id,purpose,consent_version)
);

create table if not exists financing_marketplace_support_cases (
 id text primary key,
 organization_id text not null references partner_organizations(id) on delete cascade,
 provider_id text not null references financing_providers(id),
 financing_case_id text references financing_application_cases(id) on delete set null,
 opened_by_user_id text,
 category text not null check(category in ('application_help','technical','data_access','partner_service','other')),
 description text not null check(char_length(description) between 3 and 5000),
 status text not null default 'open' check(status in ('open','assigned','waiting_partner','waiting_customer','resolved','closed')),
 assigned_to_user_id text,
 provider_reference text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 resolved_at timestamptz
);
create index if not exists financing_marketplace_support_queue_idx
 on financing_marketplace_support_cases(organization_id,status,created_at);

create or replace function guard_financing_marketplace_access() returns trigger language plpgsql as $$
declare partner_status text; security_status text; integration_state text; commercial_state text; channel_enabled boolean;
begin
 if new.status in ('issued','accepted') and (tg_op='INSERT' or new.status is distinct from old.status) then
   select marketplace_partner_status,security_review_status,integration_status,commercial_status,customer_channel_enabled
   into partner_status,security_status,integration_state,commercial_state,channel_enabled
   from financing_providers where id=new.provider_id;
   if partner_status<>'active' or security_status not in ('passed','waived') or integration_state<>'ready'
      or commercial_state<>'active' or channel_enabled is not true then
     raise exception 'financing provider is not enabled for ELEMARKET customer-facing financing';
   end if;
 end if;
 return new;
end $$;
drop trigger if exists financing_offer_provider_eligibility_guard on financing_offers;
drop trigger if exists financing_offer_marketplace_access_guard on financing_offers;
create trigger financing_offer_marketplace_access_guard before insert or update on financing_offers
 for each row execute function guard_financing_marketplace_access();

comment on column financing_providers.provider_supplied_reference is
 'Optional provider-supplied business/reference metadata. ELEMARKET does not certify regulatory licensing through this field.';
comment on table financing_marketplace_consents is
 'ELEMARKET evidence that the user permitted marketplace processing/sharing with the selected financing provider.';
comment on table financing_marketplace_support_cases is
 'Marketplace support/routing records only; lender regulatory complaints remain the provider responsibility.';
