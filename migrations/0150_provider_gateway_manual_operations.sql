-- V2012: dedicated Provider Hub onboarding and manual-operations gateway.
-- Provider applicants never self-grant operational access. Admin approval creates
-- the partner tenant, capabilities, owner membership and manual provider connection.

create table if not exists provider_gateway_applications (
  id text primary key,
  applicant_user_id text not null,
  organization_name text not null check(char_length(organization_name) between 2 and 160),
  contact_email text not null check(char_length(contact_email) between 3 and 254),
  contact_phone text,
  website_url text check(website_url is null or website_url ~* '^https://[^[:space:]]+$'),
  requested_capabilities text[] not null,
  processing_mode text not null default 'manual' check(processing_mode in ('manual','hybrid','api')),
  service_description text not null check(char_length(service_description) between 10 and 3000),
  status text not null default 'review' check(status in ('review','information_requested','approved','rejected','withdrawn')),
  admin_note text,
  reviewed_by_user_id text,
  reviewed_at timestamptz,
  organization_id text references partner_organizations(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(cardinality(requested_capabilities) between 1 and 3),
  check(requested_capabilities <@ array['delivery','customer_financing','merchant_financing']::text[])
);
create index if not exists provider_gateway_applicant_idx
  on provider_gateway_applications(applicant_user_id,created_at desc);
create unique index if not exists provider_gateway_one_open_application_uq
  on provider_gateway_applications(applicant_user_id)
  where status in ('review','information_requested');

alter table partner_organizations
  add column if not exists provider_gateway_application_id text references provider_gateway_applications(id);

alter table partner_organizations
  add column if not exists preferred_processing_mode text not null default 'manual'
    check(preferred_processing_mode in ('manual','hybrid','api'));

comment on table provider_gateway_applications is
  'Dedicated /provider signup applications. Operational partner access is created only by ELEMARKET admin approval.';
comment on column partner_organizations.preferred_processing_mode is
  'Provider operating preference. Manual mode supports SMEs that process applications/jobs through the Provider Hub without an API.';
