-- V2013: provider-configured initial financing deposits, paid directly through
-- a configured payment-provider account for the selected financing provider.

alter table financing_provider_forms
  add column if not exists deposit_type text not null default 'none'
    check(deposit_type in ('none','fixed','percentage')),
  add column if not exists deposit_value numeric(12,2)
    check(deposit_value is null or deposit_value >= 0),
  add column if not exists deposit_due_stage text not null default 'on_application'
    check(deposit_due_stage in ('on_application','after_approval')),
  add constraint financing_provider_form_deposit_config_check
    check(
      (deposit_type='none' and coalesce(deposit_value,0)=0)
      or (deposit_type='fixed' and deposit_value>0)
      or (deposit_type='percentage' and deposit_value>0 and deposit_value<100)
    ) not valid;

alter table customer_financing_applications
  add column if not exists initial_deposit_status text not null default 'not_required'
    check(initial_deposit_status in ('not_required','pending','authorized','paid','failed','refunded')),
  add column if not exists provider_form_id text references financing_provider_forms(id),
  add column if not exists provider_form_version integer;

create table if not exists financing_provider_payment_accounts (
  financing_provider_id text not null references financing_providers(id) on delete cascade,
  payment_provider_key text not null references payment_providers(provider_key),
  provider_account_ref text not null check(char_length(provider_account_ref) between 2 and 256),
  status text not null default 'active' check(status in ('active','suspended','disabled')),
  created_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(financing_provider_id,payment_provider_key)
);

create table if not exists financing_deposit_payments (
  id text primary key,
  application_id text not null unique references customer_financing_applications(id) on delete cascade,
  user_id text not null,
  financing_provider_id text not null references financing_providers(id),
  payment_provider_key text not null references payment_providers(provider_key),
  provider_account_ref text not null,
  amount numeric(12,2) not null check(amount>0),
  currency char(3) not null default 'GHS' check(currency='GHS'),
  method text not null check(method in ('mobile_money','card','bank_transfer')),
  status text not null default 'initiated' check(status in ('initiated','authorized','completed','failed','refunded')),
  provider_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists financing_deposit_user_idx on financing_deposit_payments(user_id,created_at desc);
create index if not exists financing_deposit_provider_idx on financing_deposit_payments(financing_provider_id,status,created_at desc);

create table if not exists financing_deposit_payment_attempts (
  id text primary key,
  deposit_payment_id text not null references financing_deposit_payments(id) on delete cascade,
  attempt_no integer not null check(attempt_no>0),
  provider_key text not null references payment_providers(provider_key),
  provider_reference text,
  checkout_url text,
  status text not null default 'initiated' check(status in ('initiated','pending','authorized','completed','failed')),
  initiation_token text,
  initiation_expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check(jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(deposit_payment_id,attempt_no)
);
create unique index if not exists financing_deposit_provider_reference_uq
  on financing_deposit_payment_attempts(provider_key,provider_reference)
  where provider_reference is not null;

create table if not exists financing_deposit_webhook_events (
  id bigserial primary key,
  provider_key text not null,
  event_id text not null,
  provider_reference text not null,
  payload_hash text not null,
  status text not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(provider_key,event_id)
);

comment on table financing_provider_payment_accounts is
  'Settlement destination reference owned by the financing provider. ELEMARKET passes this through the payment adapter for direct provider settlement of initial deposits.';
comment on table financing_deposit_payments is
  'Initial financing contribution only. Never marks the merchandise order paid and never represents full purchase settlement.';
