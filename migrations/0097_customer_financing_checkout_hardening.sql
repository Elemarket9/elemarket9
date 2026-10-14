-- v1.67: high-grade customer financing quote/application boundary.
-- Financing is NOT a payment method. A customer financing application must be
-- provider-approved before any order is treated as funded/paid.

create table if not exists customer_financing_quotes (
  id text primary key,
  user_id text not null,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'GHS' check (currency = 'GHS'),
  cart_fingerprint text not null check (cart_fingerprint ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists customer_financing_quote_user_idx
  on customer_financing_quotes(user_id, created_at desc);
create index if not exists customer_financing_quote_expiry_idx
  on customer_financing_quotes(expires_at);

alter table customer_financing_applications
  add column if not exists quote_id text references customer_financing_quotes(id),
  add column if not exists provider_decision_at timestamptz,
  add column if not exists approved_amount numeric(12,2),
  add column if not exists approved_initial_contribution numeric(12,2),
  add column if not exists approved_currency char(3),
  add column if not exists provider_terms jsonb not null default '{}'::jsonb;

alter table customer_financing_applications
  drop constraint if exists customer_financing_approved_amount_check;
alter table customer_financing_applications
  add constraint customer_financing_approved_amount_check
  check (approved_amount is null or (approved_amount > 0 and approved_amount <= amount));

alter table customer_financing_applications
  drop constraint if exists customer_financing_approved_currency_check;
alter table customer_financing_applications
  add constraint customer_financing_approved_currency_check
  check (approved_currency is null or approved_currency = currency);

create unique index if not exists customer_financing_quote_application_uq
  on customer_financing_applications(quote_id)
  where quote_id is not null;

create index if not exists customer_financing_provider_status_idx
  on customer_financing_applications(provider_id, status, updated_at desc);

comment on table customer_financing_quotes is
  'Short-lived server-calculated financing quote. It is not an approval, credit decision, or payment authorization.';
comment on column customer_financing_applications.approved_amount is
  'Provider-returned approved amount only. Null until the provider approves; ELEMARKET never derives approval from its own score.';
comment on column customer_financing_applications.provider_terms is
  'Provider-returned financing terms only. Never client-controlled and never interpreted as an ELEMARKET credit decision.';
