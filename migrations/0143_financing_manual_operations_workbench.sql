-- Manual / hybrid / API financing operations workbench.
-- Provider-neutral. ELEMARKET stores provider workflow state; the financing provider remains decision-maker.
alter table financing_providers add column if not exists manual_operations_enabled boolean not null default false;
alter table financing_providers add column if not exists supervisor_approval_required boolean not null default false;
alter table financing_providers add column if not exists application_sla_hours integer not null default 48 check(application_sla_hours between 1 and 720);

create table if not exists financing_application_cases (
 id text primary key,
 organization_id text not null references partner_organizations(id) on delete cascade,
 provider_id text not null references financing_providers(id),
 application_audience text not null check(application_audience in ('customer','merchant')),
 application_id text not null,
 workflow_status text not null default 'new' check(workflow_status in ('new','assigned','under_review','information_requested','awaiting_supervisor','offer_issued','offer_accepted','offer_declined','approved','declined','disbursed','repaying','completed','cancelled')),
 assigned_to_user_id text,
 assigned_at timestamptz,
 sla_due_at timestamptz not null,
 last_activity_at timestamptz not null default now(),
 version integer not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(provider_id,application_audience,application_id)
);
create index if not exists financing_case_queue_idx on financing_application_cases(organization_id,workflow_status,sla_due_at);

create table if not exists financing_case_events (
 id text primary key, case_id text not null references financing_application_cases(id) on delete cascade,
 organization_id text not null references partner_organizations(id) on delete cascade,
 actor_user_id text, event_type text not null,
 note text, metadata jsonb not null default '{}'::jsonb check(jsonb_typeof(metadata)='object'),
 created_at timestamptz not null default now()
);
create index if not exists financing_case_events_case_idx on financing_case_events(case_id,created_at);

create table if not exists financing_information_requests (
 id text primary key, case_id text not null references financing_application_cases(id) on delete cascade,
 organization_id text not null references partner_organizations(id) on delete cascade,
 requested_by_user_id text, request_text text not null check(char_length(request_text) between 3 and 2000),
 status text not null default 'open' check(status in ('open','submitted','accepted','cancelled')),
 due_at timestamptz, responded_at timestamptz, created_at timestamptz not null default now()
);

create table if not exists financing_case_documents (
 id text primary key, case_id text not null references financing_application_cases(id) on delete cascade,
 organization_id text not null references partner_organizations(id) on delete cascade,
 document_type text not null, storage_reference text not null,
 original_filename text, content_type text, size_bytes bigint check(size_bytes is null or (size_bytes >= 0 and size_bytes <= 10485760)),
 sha256 text check(sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
 uploaded_by_user_id text, malware_scan_status text not null default 'pending' check(malware_scan_status in ('pending','clean','blocked','failed')),
 created_at timestamptz not null default now()
);
create index if not exists financing_case_documents_case_idx on financing_case_documents(case_id,created_at);

create table if not exists financing_offers (
 id text primary key, case_id text not null references financing_application_cases(id) on delete cascade,
 organization_id text not null references partner_organizations(id) on delete cascade,
 provider_id text not null references financing_providers(id),
 amount numeric(12,2) not null check(amount>0), currency char(3) not null,
 deposit_amount numeric(12,2) check(deposit_amount is null or deposit_amount>=0),
 tenure_months integer check(tenure_months is null or tenure_months between 1 and 120),
 provider_terms jsonb not null default '{}'::jsonb check(jsonb_typeof(provider_terms)='object'),
 status text not null default 'draft' check(status in ('draft','pending_supervisor','issued','accepted','declined','expired','withdrawn')),
 expires_at timestamptz not null, created_by_user_id text, approved_by_user_id text,
 issued_at timestamptz, responded_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(expires_at > created_at)
);
create index if not exists financing_offers_case_idx on financing_offers(case_id,status,created_at desc);

create table if not exists financing_servicing_updates (
 id text primary key, case_id text not null references financing_application_cases(id) on delete cascade,
 organization_id text not null references partner_organizations(id) on delete cascade,
 update_type text not null check(update_type in ('purchase_authorized','disbursed','repayment_current','repayment_late','repayment_completed','cancelled')),
 provider_reference text, effective_at timestamptz not null, metadata jsonb not null default '{}'::jsonb check(jsonb_typeof(metadata)='object'),
 recorded_by_user_id text, idempotency_key text not null, created_at timestamptz not null default now(),
 unique(organization_id,idempotency_key)
);

comment on table financing_application_cases is 'Provider-owned operational workflow for manual/hybrid/API financing. Not an ELEMARKET underwriting engine.';
comment on table financing_offers is 'Terms entered or supplied by the licensed financing provider; ELEMARKET does not calculate or recommend credit terms.';
