-- Production-grade external Partner Hub controls. Provider-neutral; ELEMARKET never underwrites credit.
alter table partner_organizations add column if not exists external_reference text;
alter table partner_organizations add column if not exists contact_email text;
alter table partner_organizations add column if not exists approved_at timestamptz;
alter table partner_organizations add column if not exists approved_by_user_id text;

create table if not exists partner_webhook_endpoints (
 id text primary key, organization_id text not null references partner_organizations(id) on delete cascade,
 capability text not null check(capability in ('delivery','customer_financing','merchant_financing')),
 endpoint_url text not null check(endpoint_url ~* '^https://[^[:space:]]+$'), status text not null default 'disabled' check(status in ('disabled','active','suspended')),
 signing_secret_ciphertext text, last_success_at timestamptz,last_failure_at timestamptz,failure_count integer not null default 0 check(failure_count>=0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(), unique(organization_id,capability,endpoint_url)
);
create index if not exists partner_webhook_org_idx on partner_webhook_endpoints(organization_id,capability,status);

create table if not exists partner_api_credentials (
 id text primary key, organization_id text not null references partner_organizations(id) on delete cascade,
 label text not null check(char_length(label) between 2 and 100), key_prefix text not null unique, secret_hash text not null,
 scopes text[] not null default '{}', status text not null default 'active' check(status in ('active','revoked','expired')),
 expires_at timestamptz not null,last_used_at timestamptz,created_by_user_id text,created_at timestamptz not null default now(),revoked_at timestamptz,
 check(expires_at > created_at), check(expires_at <= created_at + interval '365 days')
);
create index if not exists partner_api_credentials_org_idx on partner_api_credentials(organization_id,status,expires_at);

alter table delivery_jobs add column if not exists accepted_at timestamptz;
alter table delivery_jobs add column if not exists in_transit_at timestamptz;
alter table delivery_jobs add column if not exists failed_at timestamptz;
alter table delivery_jobs add column if not exists return_requested_at timestamptz;
alter table delivery_jobs add column if not exists returned_at timestamptz;
alter table delivery_jobs add column if not exists proof_of_delivery_reference text;
alter table delivery_jobs add column if not exists version integer not null default 0;

create or replace function enforce_delivery_job_transition() returns trigger language plpgsql as $$
begin
 if tg_op='UPDATE' and new.status is distinct from old.status then
   if not ((old.status='assigned' and new.status in ('accepted','cancelled')) or
           (old.status='accepted' and new.status in ('picked_up','failed','cancelled')) or
           (old.status='picked_up' and new.status in ('in_transit','failed')) or
           (old.status='in_transit' and new.status in ('delivered','failed')) or
           (old.status='delivered' and new.status='return_requested') or
           (old.status='return_requested' and new.status='returned')) then
      raise exception 'invalid delivery job transition % -> %',old.status,new.status;
   end if;
 end if;
 if new.status='accepted' and new.accepted_at is null then new.accepted_at=now(); end if;
 if new.status='picked_up' and new.picked_up_at is null then new.picked_up_at=now(); end if;
 if new.status='in_transit' and new.in_transit_at is null then new.in_transit_at=now(); end if;
 if new.status='delivered' and new.delivered_at is null then new.delivered_at=now(); end if;
 if new.status='failed' and new.failed_at is null then new.failed_at=now(); end if;
 if new.status='return_requested' and new.return_requested_at is null then new.return_requested_at=now(); end if;
 if new.status='returned' and new.returned_at is null then new.returned_at=now(); end if;
 new.version=old.version+1; new.updated_at=now(); return new;
end $$;
drop trigger if exists delivery_job_transition_guard on delivery_jobs;
create trigger delivery_job_transition_guard before update on delivery_jobs for each row execute function enforce_delivery_job_transition();

create table if not exists financing_provider_decisions (
 id text primary key, organization_id text not null references partner_organizations(id), provider_id text not null references financing_providers(id),
 application_audience text not null check(application_audience in ('customer','merchant')), application_id text not null,
 decision text not null check(decision in ('approved','declined')), provider_reference text not null,
 approved_amount numeric(12,2), currency char(3), terms jsonb not null default '{}'::jsonb check(jsonb_typeof(terms)='object'),
 reason_code text, decided_by_user_id text, idempotency_key text not null, created_at timestamptz not null default now(),
 unique(provider_id,application_audience,application_id), unique(organization_id,idempotency_key),
 check((decision='approved' and approved_amount is not null and approved_amount>0) or (decision='declined' and approved_amount is null))
);
create index if not exists financing_provider_decisions_org_idx on financing_provider_decisions(organization_id,created_at desc);

comment on table financing_provider_decisions is 'Immutable provider-originated credit decisions. ELEMARKET stores/orchestrates but never derives approval.';
comment on table partner_api_credentials is 'Hashed external partner credentials. Plaintext secret is never persisted.';
