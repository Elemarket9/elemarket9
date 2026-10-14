-- ELEMARKET security/integrity hardening.
-- This migration adds ownership boundaries and replay-resistant financing records.

-- A merchant account must be explicitly bound to a verified application user before
-- that user can submit merchant-capital applications. Seed/catalogue merchants can
-- remain unbound until onboarding creates the ownership row.
create table if not exists merchant_accounts (
  merchant_id text primary key references merchants(id) on delete cascade,
  user_id text not null,
  status text not null default 'active' check (status in ('active','suspended','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists merchant_accounts_user_merchant_uq
  on merchant_accounts(user_id, merchant_id);
create index if not exists merchant_accounts_user_idx
  on merchant_accounts(user_id, status);

-- Financing applications must only point to a provider serving the same audience.
create or replace function validate_financing_provider_audience()
returns trigger language plpgsql as $$
declare
  v_audience text;
begin
  select audience into v_audience from financing_providers where id = new.provider_id;
  if v_audience is null then
    raise exception 'financing provider not found';
  end if;
  if tg_table_name = 'customer_financing_applications' and v_audience <> 'customer' then
    raise exception 'provider is not a customer financing provider';
  end if;
  if tg_table_name = 'merchant_financing_applications' and v_audience <> 'merchant' then
    raise exception 'provider is not a merchant financing provider';
  end if;
  return new;
end;
$$;
drop trigger if exists customer_financing_provider_validate on customer_financing_applications;
create trigger customer_financing_provider_validate
before insert or update of provider_id on customer_financing_applications
for each row execute function validate_financing_provider_audience();
drop trigger if exists merchant_financing_provider_validate on merchant_financing_applications;
create trigger merchant_financing_provider_validate
before insert or update of provider_id on merchant_financing_applications
for each row execute function validate_financing_provider_audience();

-- Prevent an application from being created against a cancelled/expired order and
-- ensure the application amount can never exceed the server-authoritative order total.
create or replace function validate_customer_financing_order()
returns trigger language plpgsql as $$
declare
  v_user text;
  v_status text;
  v_total numeric(12,2);
begin
  if new.order_group_id is null then return new; end if;
  select og.user_id, case when bool_or(o.status in ('cancelled','disputed')) then 'blocked' else 'ok' end, coalesce(sum(o.grand_total),0)
    into v_user, v_status, v_total
    from order_groups og
    left join orders o on o.group_id = og.id
   where og.id = new.order_group_id
   group by og.user_id;
  if v_user is null then raise exception 'order group not found'; end if;
  if v_user <> new.user_id then raise exception 'order group ownership mismatch'; end if;
  if v_status in ('cancelled','disputed') then raise exception 'order is not financeable'; end if;
  if v_total <= 0 or new.amount > v_total then raise exception 'financing amount exceeds order total'; end if;
  return new;
end;
$$;
drop trigger if exists customer_financing_order_validate on customer_financing_applications;
create trigger customer_financing_order_validate
before insert or update of user_id, order_group_id, amount on customer_financing_applications
for each row execute function validate_customer_financing_order();

-- Provider callback replay protection. The provider event id is unique per provider;
-- application id is retained for audit/reconciliation.
create table if not exists financing_webhook_events (
  id text primary key,
  provider_id text not null references financing_providers(id),
  provider_event_id text not null,
  application_id text,
  audience text not null check (audience in ('customer','merchant')),
  event_type text not null check (char_length(event_type) between 2 and 120),
  payload_hash text not null check (char_length(payload_hash) between 32 and 128),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received' check (processing_status in ('received','processed','rejected','failed')),
  unique(provider_id, provider_event_id)
);
create index if not exists financing_webhook_events_application_idx
  on financing_webhook_events(application_id, received_at desc);

-- Score band must agree with the score; otherwise a stale/manual band could grant
-- an unintended financing classification.
create or replace function validate_merchant_score_band()
returns trigger language plpgsql as $$
declare expected text;
begin
  expected := case
    when new.score < 400 then 'not_ready'
    when new.score < 550 then 'building'
    when new.score < 700 then 'eligible_small'
    when new.score < 850 then 'eligible_medium'
    else 'strong_profile'
  end;
  if new.band <> expected then
    raise exception 'merchant score band does not match score';
  end if;
  return new;
end;
$$;
drop trigger if exists merchant_score_band_validate on merchant_scores;
create trigger merchant_score_band_validate
before insert or update of score, band on merchant_scores
for each row execute function validate_merchant_score_band();

-- Financing flags must never advertise a negative/zero range.
alter table products drop constraint if exists products_financing_range_check;
alter table products add constraint products_financing_range_check
  check (
    (financing_min_amount is null or financing_min_amount >= 0) and
    (financing_max_amount is null or financing_max_amount >= 0) and
    (financing_min_amount is null or financing_max_amount is null or financing_min_amount <= financing_max_amount)
  ) not valid;

-- Keep the financing flag authoritative: a product must be active/verified before
-- it can be marked financeable. This is enforced on writes, not by the UI.
create or replace function validate_product_financing()
returns trigger language plpgsql as $$
declare v_verified boolean; v_status text;
begin
  if not new.financing_eligible then return new; end if;
  select verified, status into v_verified, v_status from merchants where id = new.merchant_id;
  if coalesce(v_verified,false) is not true or v_status <> 'active' then
    raise exception 'only active verified merchants can offer financing';
  end if;
  return new;
end;
$$;
drop trigger if exists products_financing_validate on products;
create trigger products_financing_validate
before insert or update of merchant_id, financing_eligible on products
for each row execute function validate_product_financing();
