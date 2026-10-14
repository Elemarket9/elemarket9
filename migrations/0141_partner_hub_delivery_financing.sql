-- Provider-neutral Partner Hub for delivery and financing organizations.
create table if not exists partner_organizations (
  id text primary key,
  name text not null check (char_length(name) between 2 and 160),
  status text not null default 'review' check (status in ('review','active','suspended','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists partner_organization_capabilities (
  organization_id text not null references partner_organizations(id) on delete cascade,
  capability text not null check (capability in ('delivery','customer_financing','merchant_financing')),
  primary key (organization_id, capability)
);
create table if not exists partner_organization_users (
  organization_id text not null references partner_organizations(id) on delete cascade,
  user_id text not null,
  role text not null check (role in ('owner','admin','operator','analyst')),
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now(),
  primary key (organization_id,user_id)
);
create index if not exists partner_org_users_user_idx on partner_organization_users(user_id,status);

alter table financing_providers add column if not exists partner_organization_id text references partner_organizations(id);
create index if not exists financing_provider_partner_org_idx on financing_providers(partner_organization_id) where partner_organization_id is not null;

create table if not exists delivery_providers (
  id text primary key,
  provider_key text not null unique,
  name text not null check (char_length(name) between 2 and 160),
  partner_organization_id text references partner_organizations(id),
  status text not null default 'review' check (status in ('review','active','suspended','inactive')),
  integration_mode text not null default 'api' check (integration_mode in ('api','manual','partner_handoff')),
  environment text not null default 'sandbox' check (environment in ('sandbox','production')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists delivery_provider_partner_org_idx on delivery_providers(partner_organization_id) where partner_organization_id is not null;

alter table delivery_quotes add column if not exists provider_id text references delivery_providers(id);
alter table delivery_quotes add column if not exists provider_reference text;

create table if not exists delivery_jobs (
  id text primary key,
  order_id text not null unique references orders(id),
  provider_id text not null references delivery_providers(id),
  provider_reference text,
  status text not null default 'assigned' check (status in ('assigned','accepted','picked_up','in_transit','delivered','failed','return_requested','returned','cancelled')),
  tracking_url text,
  proof_of_delivery_url text,
  failure_reason text,
  assigned_at timestamptz not null default now(), picked_up_at timestamptz, delivered_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists delivery_jobs_provider_status_idx on delivery_jobs(provider_id,status,updated_at desc);

create table if not exists partner_audit_events (
  id bigserial primary key, organization_id text not null references partner_organizations(id), user_id text,
  action text not null, resource_type text not null, resource_id text, outcome text not null check (outcome in ('success','denied','failure')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'), created_at timestamptz not null default now()
);
create index if not exists partner_audit_org_idx on partner_audit_events(organization_id,created_at desc);

comment on table partner_organizations is 'Provider-neutral external partner tenant. Capabilities, not provider names, determine portal access.';
comment on table delivery_jobs is 'Normalized ELEMARKET delivery work. Provider-specific protocol details remain inside adapters.';
