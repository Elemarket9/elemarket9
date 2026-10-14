-- ELEMARKET financing orchestration foundation.
-- ELEMARKET presents partner financing; providers make credit decisions and fund transactions.
-- Merchant capital is based on marketplace performance signals and provider underwriting.

alter table products add column if not exists financing_eligible boolean not null default false;
alter table products add column if not exists financing_min_amount numeric(12,2);
alter table products add column if not exists financing_max_amount numeric(12,2);
alter table products add constraint products_financing_range_check check ((financing_min_amount is null or financing_min_amount >= 0) and (financing_max_amount is null or financing_max_amount >= 0) and (financing_min_amount is null or financing_max_amount is null or financing_min_amount <= financing_max_amount)) not valid;

create table if not exists financing_providers (
  id text primary key, provider_key text not null unique, name text not null check (char_length(name) between 2 and 160),
  audience text not null check (audience in ('customer','merchant')),
  product_type text not null check (product_type in ('bnpl','installment','merchant_cash_advance','line_of_credit','term_loan')),
  status text not null default 'active' check (status in ('active','inactive','review')), application_url text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists financing_providers_audience_idx on financing_providers(audience, product_type, status);

create table if not exists customer_financing_applications (
  id text primary key, user_id text not null, provider_id text not null references financing_providers(id), order_group_id text references order_groups(id),
  amount numeric(12,2) not null check (amount > 0), currency char(3) not null default 'GHS' check (currency = 'GHS'),
  status text not null check (status in ('started','pending','approved','declined','cancelled','expired')), provider_reference text, redirect_url text, expires_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists customer_financing_user_idx on customer_financing_applications(user_id, created_at desc);
create index if not exists customer_financing_order_idx on customer_financing_applications(order_group_id);

create table if not exists merchant_scores (
  merchant_id text primary key references merchants(id), score integer not null check (score between 0 and 1000),
  band text not null check (band in ('not_ready','building','eligible_small','eligible_medium','strong_profile')), model_version text not null,
  components jsonb not null default '{}'::jsonb check (jsonb_typeof(components) = 'object'), calculated_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists merchant_scores_band_idx on merchant_scores(band, score desc);

create table if not exists merchant_financing_applications (
  id text primary key, merchant_id text not null references merchants(id), provider_id text not null references financing_providers(id),
  requested_amount numeric(12,2) not null check (requested_amount > 0), currency char(3) not null default 'GHS' check (currency = 'GHS'),
  status text not null check (status in ('started','pending','approved','declined','cancelled','expired')), provider_reference text, redirect_url text,
  score_snapshot integer check (score_snapshot is null or score_snapshot between 0 and 1000), score_model_version text, expires_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists merchant_financing_merchant_idx on merchant_financing_applications(merchant_id, created_at desc);

insert into financing_providers(id, provider_key, name, audience, product_type, status) values
  ('customer-bnpl-external','customer-bnpl-external','External BNPL Provider','customer','bnpl','review'),
  ('customer-installment-external','customer-installment-external','External Installment Provider','customer','installment','review'),
  ('merchant-capital-external','merchant-capital-external','External Merchant Capital Provider','merchant','merchant_cash_advance','review'),
  ('merchant-loan-external','merchant-loan-external','External Merchant Loan Provider','merchant','term_loan','review')
on conflict (provider_key) do nothing;

-- Initial catalogue examples: finance durable goods only. Provider approval remains required.
update products set financing_eligible = true where id in ('p_phone','p_earbuds','p_laptop');
