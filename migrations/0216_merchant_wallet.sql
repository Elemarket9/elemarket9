-- Merchant wallet: a provider-neutral, append-only ledger of what each merchant
-- has earned, what is withheld, what is available to withdraw, what is being
-- paid out and what has been paid.
--
-- Custody boundary: customer money stays in the platform's account at the
-- connected payment provider. ELEMARKET records entitlements and sends payout
-- commands through a configured payout driver. It never moves funds itself.
--
-- Opt-in per merchant (settlement_model='platform_wallet'). provider_direct
-- merchants keep being paid by the checkout split, so their sales are never
-- credited here, and no historical order is backfilled: those funds were
-- already settled by the provider. Crediting them would pay merchants twice.

alter table merchants drop constraint if exists merchants_settlement_model_check;
alter table merchants add constraint merchants_settlement_model_check
  check (settlement_model in ('provider_direct','enterprise_direct','platform_wallet')) not valid;
alter table merchants validate constraint merchants_settlement_model_check;
comment on column merchants.settlement_model is
  'provider_direct: provider pays the merchant at checkout (split). enterprise_direct: external enterprise settlement. platform_wallet: charge stays in the platform provider account; the merchant wallet ledger releases funds and issues payout commands.';

-- Payout destinations are opaque provider tokens. Raw account numbers are never stored.
alter table merchant_payout_accounts add column if not exists driver_key text;
alter table merchant_payout_accounts add column if not exists display_hint text
  check (display_hint is null or char_length(display_hint) <= 64);
alter table merchant_payout_accounts add column if not exists account_name text
  check (account_name is null or char_length(account_name) <= 160);
alter table merchant_payout_accounts add column if not exists verified_at timestamptz;

-- How each charge was set up, fixed when it is first initialized. The wallet
-- credits a sale only when the charge itself stayed in the platform account,
-- so a late payment started under the split can never be paid twice, and a
-- wallet charge is still credited if the merchant's mode changes afterwards.
alter table payments add column if not exists settlement_model text
  check (settlement_model is null or settlement_model in ('provider_split','platform_wallet'));
create or replace function payments_settlement_model_write_once() returns trigger language plpgsql as $$
begin
  if old.settlement_model is not null and new.settlement_model is distinct from old.settlement_model then
    raise exception 'payment settlement model is fixed once the charge is initialized';
  end if;
  return new;
end $$;
drop trigger if exists payments_settlement_model_once on payments;
create trigger payments_settlement_model_once before update of settlement_model on payments
  for each row execute function payments_settlement_model_write_once();

create table if not exists wallet_payouts (
  id text primary key,
  merchant_id text not null references merchants(id) on delete restrict,
  destination_id text not null references merchant_payout_accounts(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0 and amount <= 1000000),
  fee numeric(12,2) not null default 0 check (fee >= 0),
  net_amount numeric(12,2) generated always as (amount - fee) stored,
  currency char(3) not null default 'GHS' check (currency = 'GHS'),
  driver_key text not null check (driver_key ~ '^[A-Za-z0-9_-]{2,64}$'),
  provider_reference text check (provider_reference is null or char_length(provider_reference) <= 256),
  status text not null default 'requested'
    check (status in ('requested','processing','paid','failed','needs_attention')),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 128),
  requested_by text not null,
  dispatch_attempts integer not null default 0 check (dispatch_attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_token text,
  lease_until timestamptz,
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (fee < amount),
  unique (merchant_id, idempotency_key)
);
create unique index if not exists wallet_payouts_one_active_per_merchant
  on wallet_payouts(merchant_id) where status in ('requested','processing','needs_attention');
create unique index if not exists wallet_payouts_provider_ref_uq
  on wallet_payouts(driver_key, provider_reference) where provider_reference is not null;
create index if not exists wallet_payouts_dispatch_idx on wallet_payouts(status, next_attempt_at);

create table if not exists wallet_ledger_entries (
  id bigserial primary key,
  merchant_id text not null references merchants(id) on delete restrict,
  entry_type text not null check (entry_type in (
    'sale','release','refund','payout_requested','payout_paid','payout_fee','payout_returned')),
  bucket text not null check (bucket in ('withheld','available','processing','paid_out','fees')),
  amount numeric(12,2) not null check (amount <> 0),
  currency char(3) not null default 'GHS' check (currency = 'GHS'),
  order_id text references orders(id) on delete restrict,
  payout_id text references wallet_payouts(id) on delete restrict,
  source_key text not null unique check (char_length(source_key) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists wallet_ledger_merchant_idx on wallet_ledger_entries(merchant_id, created_at desc);
create index if not exists wallet_ledger_order_idx on wallet_ledger_entries(order_id) where order_id is not null;
comment on table wallet_ledger_entries is
  'Append-only merchant entitlement ledger. Balance per bucket = sum(amount). Every movement between buckets is a pair of rows that nets to zero.';

create or replace function wallet_ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'wallet ledger is append-only';
end $$;
drop trigger if exists wallet_ledger_immutable on wallet_ledger_entries;
create trigger wallet_ledger_immutable before update or delete on wallet_ledger_entries
  for each row execute function wallet_ledger_append_only();

create or replace view merchant_wallet_balances as
select m.id as merchant_id,
       coalesce(sum(e.amount) filter (where e.entry_type = 'sale'), 0)::numeric(12,2) as total_sales,
       coalesce(-sum(e.amount) filter (where e.entry_type = 'refund'), 0)::numeric(12,2) as refunded,
       coalesce(sum(e.amount) filter (where e.bucket = 'withheld'), 0)::numeric(12,2) as withheld,
       coalesce(sum(e.amount) filter (where e.bucket = 'available'), 0)::numeric(12,2) as available,
       coalesce(sum(e.amount) filter (where e.bucket = 'processing'), 0)::numeric(12,2) as processing,
       coalesce(sum(e.amount) filter (where e.bucket = 'paid_out'), 0)::numeric(12,2) as paid_out,
       coalesce(sum(e.amount) filter (where e.bucket = 'fees'), 0)::numeric(12,2) as payout_fees
  from merchants m
  left join wallet_ledger_entries e on e.merchant_id = m.id
 group by m.id;

-- Sale credit: when a charge that stayed in the platform account completes,
-- the merchant's share (merchant_net: product total minus platform commission;
-- delivery is not merchant revenue) is credited as withheld.
create or replace function wallet_credit_completed_payment() returns trigger language plpgsql as $$
declare v_order record;
begin
  if new.status <> 'completed' or old.status = 'completed' then return new; end if;
  if new.settlement_model is distinct from 'platform_wallet' then return new; end if;
  select o.id, o.merchant_id, o.merchant_net into v_order from orders o where o.id = new.order_id;
  if not found or coalesce(v_order.merchant_net, 0) <= 0 then
    return new;
  end if;
  insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
  values (v_order.merchant_id, 'sale', 'withheld', v_order.merchant_net, v_order.id, 'sale:' || v_order.id)
  on conflict (source_key) do nothing;
  return new;
end $$;
drop trigger if exists wallet_sale_credit on payments;
create trigger wallet_sale_credit after update of status on payments
  for each row execute function wallet_credit_completed_payment();

-- Remaining merchant entitlement for an order that can still be refunded.
create or replace function wallet_order_refundable(p_order_id text) returns numeric language sql stable as $$
  select coalesce(sum(amount) filter (where entry_type = 'sale'), 0)
       + coalesce(sum(amount) filter (where entry_type = 'refund'), 0)
    from wallet_ledger_entries where order_id = p_order_id
$$;

-- Debit a refund from the order's withheld funds first, then from available.
-- Available may go negative after a late refund; withdrawals then wait until
-- new releases cover it.
create or replace function wallet_apply_refund(p_order_id text, p_amount numeric, p_source text)
returns numeric language plpgsql as $$
declare
  v_merchant text;
  v_cap numeric(12,2);
  v_debit numeric(12,2);
  v_withheld numeric(12,2);
  v_from_withheld numeric(12,2);
begin
  select merchant_id into v_merchant from orders where id = p_order_id;
  if v_merchant is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:wallet:' || v_merchant, 0));
  v_cap := wallet_order_refundable(p_order_id);
  v_debit := least(round(coalesce(p_amount, 0), 2), v_cap);
  if v_debit <= 0 then return 0; end if;
  select coalesce(sum(amount), 0) into v_withheld
    from wallet_ledger_entries where order_id = p_order_id and bucket = 'withheld';
  v_from_withheld := least(v_debit, greatest(v_withheld, 0));
  if v_from_withheld > 0 then
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
    values (v_merchant, 'refund', 'withheld', -v_from_withheld, p_order_id, p_source || ':withheld')
    on conflict (source_key) do nothing;
  end if;
  if v_debit - v_from_withheld > 0 then
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
    values (v_merchant, 'refund', 'available', -(v_debit - v_from_withheld), p_order_id, p_source || ':available')
    on conflict (source_key) do nothing;
  end if;
  return v_debit;
end $$;

-- A processed customer refund reduces the merchant's entitlement in
-- proportion to the merchant's share of the order total.
create or replace function wallet_debit_processed_refund() returns trigger language plpgsql as $$
declare v_order record;
begin
  if new.status <> 'processed' or (tg_op = 'UPDATE' and old.status = 'processed') then return new; end if;
  select id, merchant_net, grand_total into v_order from orders where id = new.order_id;
  if not found or coalesce(v_order.grand_total, 0) <= 0 then return new; end if;
  if not exists (select 1 from wallet_ledger_entries where order_id = new.order_id and entry_type = 'sale') then
    return new;
  end if;
  perform wallet_apply_refund(new.order_id,
    round(new.amount * v_order.merchant_net / v_order.grand_total, 2), 'refund:' || new.id);
  return new;
end $$;
drop trigger if exists wallet_refund_debit on provider_refund_requests;
create trigger wallet_refund_debit after insert or update of status on provider_refund_requests
  for each row execute function wallet_debit_processed_refund();

-- A fully refunded payment leaves no merchant entitlement, whatever path recorded it.
create or replace function wallet_debit_refunded_payment() returns trigger language plpgsql as $$
begin
  if new.status <> 'refunded' or old.status = 'refunded' then return new; end if;
  if exists (select 1 from wallet_ledger_entries where order_id = new.order_id and entry_type = 'sale') then
    perform wallet_apply_refund(new.order_id, wallet_order_refundable(new.order_id), 'refund-full:' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists wallet_full_refund_debit on payments;
create trigger wallet_full_refund_debit after update of status on payments
  for each row execute function wallet_debit_refunded_payment();

-- Release: withheld -> available once the customer confirmed delivery, every
-- item's return window (at least 24 hours) has passed, and nothing is open.
create or replace function release_matured_wallet_funds(p_limit integer default 200)
returns integer language plpgsql as $$
declare
  v_row record;
  v_count integer := 0;
  v_withheld numeric(12,2);
begin
  -- Start from wallet orders that still have withheld funds, not from every
  -- delivered order in the marketplace.
  for v_row in
    select o.id as order_id, o.merchant_id, w.withheld
      from (select e.order_id, sum(e.amount) as withheld
              from wallet_ledger_entries e
             where e.bucket = 'withheld' and e.order_id is not null
             group by e.order_id
            having sum(e.amount) > 0) w
      join orders o on o.id = w.order_id
     where o.status in ('delivered','completed')
       and not exists (select 1 from wallet_ledger_entries r where r.order_id = o.id and r.entry_type = 'release')
       and elemarket_order_delivered_at(o.id) is not null
       and now() >= elemarket_order_delivered_at(o.id) + greatest(
             interval '24 hours',
             make_interval(days => coalesce((select max(p.return_window_days) from order_items oi
                                              join products p on p.id = oi.product_id
                                             where oi.order_id = o.id), 0)))
       and not exists (select 1 from customer_order_disputes d
                        where d.order_id = o.id and d.status in ('open','under_review'))
       and not exists (select 1 from return_requests rr
                        where rr.order_id = o.id and rr.status in ('requested','approved','received','refund_pending'))
       and not exists (select 1 from provider_refund_requests pr
                        where pr.order_id = o.id and pr.status in ('requested','processing','needs_attention'))
     order by o.id
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
  loop
    perform pg_advisory_xact_lock(hashtextextended('elemarket:wallet:' || v_row.merchant_id, 0));
    -- Re-read under the merchant lock: a refund may have landed since the scan.
    select coalesce(sum(amount), 0) into v_withheld
      from wallet_ledger_entries where order_id = v_row.order_id and bucket = 'withheld';
    if v_withheld > 0 and not exists (select 1 from wallet_ledger_entries
                                       where order_id = v_row.order_id and entry_type = 'release') then
      insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
      values (v_row.merchant_id, 'release', 'withheld', -v_withheld, v_row.order_id, 'release:' || v_row.order_id || ':withheld'),
             (v_row.merchant_id, 'release', 'available', v_withheld, v_row.order_id, 'release:' || v_row.order_id || ':available')
      on conflict (source_key) do nothing;
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

-- Withdrawal request: available -> processing. One active payout per merchant.
-- The fee is quoted by the payout driver/config and is paid by the merchant.
create or replace function wallet_request_payout(
  p_merchant_id text, p_amount numeric, p_fee numeric, p_destination_id text,
  p_driver_key text, p_idempotency_key text, p_requested_by text)
returns jsonb language plpgsql as $$
declare
  v_existing wallet_payouts%rowtype;
  v_available numeric(12,2);
  v_dest record;
  v_id text;
  v_amount numeric(12,2) := round(p_amount, 2);
  v_fee numeric(12,2) := round(coalesce(p_fee, 0), 2);
begin
  if p_merchant_id is null or p_requested_by is null then raise exception 'merchant required'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;
  if v_amount is null or v_amount <= 0 or v_amount <> p_amount then raise exception 'invalid payout amount'; end if;
  if v_fee < 0 or v_fee >= v_amount then raise exception 'payout amount must exceed the transfer fee'; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:wallet:' || p_merchant_id, 0));

  select * into v_existing from wallet_payouts where merchant_id = p_merchant_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.amount <> v_amount or v_existing.destination_id <> p_destination_id then raise exception 'idempotency conflict'; end if;
    return jsonb_build_object('payoutId', v_existing.id, 'status', v_existing.status, 'replay', true);
  end if;

  if (select settlement_model from merchants where id = p_merchant_id) is distinct from 'platform_wallet'
     and not exists (select 1 from wallet_ledger_entries where merchant_id = p_merchant_id) then
    raise exception 'merchant wallet is not enabled';
  end if;
  select * into v_dest from merchant_payout_accounts
   where id = p_destination_id and merchant_id = p_merchant_id and status = 'verified';
  if not found then raise exception 'payout destination is not verified for this merchant'; end if;
  if v_dest.driver_key is not null and v_dest.driver_key <> p_driver_key then
    raise exception 'payout destination belongs to a different payout provider';
  end if;
  if exists (select 1 from wallet_payouts where merchant_id = p_merchant_id and status in ('requested','processing','needs_attention')) then
    raise exception 'a withdrawal is already in progress';
  end if;
  select coalesce(sum(amount), 0) into v_available
    from wallet_ledger_entries where merchant_id = p_merchant_id and bucket = 'available';
  if v_amount > v_available then raise exception 'amount exceeds available balance'; end if;

  v_id := 'wpo_' || replace(gen_random_uuid()::text, '-', '');
  insert into wallet_payouts(id, merchant_id, destination_id, amount, fee, driver_key, idempotency_key, requested_by)
  values (v_id, p_merchant_id, p_destination_id, v_amount, v_fee, p_driver_key, p_idempotency_key, p_requested_by);
  insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, payout_id, source_key)
  values (p_merchant_id, 'payout_requested', 'available', -v_amount, v_id, 'payout:' || v_id || ':available'),
         (p_merchant_id, 'payout_requested', 'processing', v_amount, v_id, 'payout:' || v_id || ':processing');
  perform record_audit_event('merchant.wallet.payout_requested', 'wallet_payout', v_id, p_requested_by, 'merchant', null, 'success',
    jsonb_build_object('merchantId', p_merchant_id, 'amount', v_amount, 'fee', v_fee, 'destinationId', p_destination_id));
  return jsonb_build_object('payoutId', v_id, 'status', 'requested', 'amount', v_amount, 'fee', v_fee,
                            'netAmount', v_amount - v_fee, 'replay', false);
end $$;

-- Final payout outcome from the provider (verified by the application).
-- paid: processing -> paid_out (net) + fees. failed: processing -> available.
create or replace function wallet_settle_payout(
  p_payout_id text, p_outcome text, p_provider_reference text, p_reason text default null)
returns jsonb language plpgsql as $$
declare v_p wallet_payouts%rowtype;
begin
  if p_outcome not in ('paid','failed','needs_attention') then raise exception 'invalid payout outcome'; end if;
  select * into v_p from wallet_payouts where id = p_payout_id;
  if not found then raise exception 'payout not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:wallet:' || v_p.merchant_id, 0));
  select * into v_p from wallet_payouts where id = p_payout_id for update;
  if v_p.status in ('paid','failed') then
    return jsonb_build_object('payoutId', v_p.id, 'status', v_p.status, 'duplicate', true);
  end if;
  if v_p.provider_reference is not null and p_provider_reference is not null
     and v_p.provider_reference <> p_provider_reference then
    raise exception 'payout provider reference mismatch';
  end if;
  if p_outcome = 'needs_attention' then
    update wallet_payouts set status = 'needs_attention', failure_reason = left(p_reason, 500),
           lease_token = null, lease_until = null, updated_at = now() where id = v_p.id;
    return jsonb_build_object('payoutId', v_p.id, 'status', 'needs_attention');
  end if;
  update wallet_payouts
     set status = p_outcome, provider_reference = coalesce(provider_reference, p_provider_reference),
         failure_reason = case when p_outcome = 'failed' then left(p_reason, 500) else null end,
         lease_token = null, lease_until = null, completed_at = now(), updated_at = now()
   where id = v_p.id;
  if p_outcome = 'paid' then
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, payout_id, source_key)
    values (v_p.merchant_id, 'payout_paid', 'processing', -v_p.amount, v_p.id, 'payout:' || v_p.id || ':settled'),
           (v_p.merchant_id, 'payout_paid', 'paid_out', v_p.net_amount, v_p.id, 'payout:' || v_p.id || ':paid_out');
    if v_p.fee > 0 then
      insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, payout_id, source_key)
      values (v_p.merchant_id, 'payout_fee', 'fees', v_p.fee, v_p.id, 'payout:' || v_p.id || ':fee');
    end if;
  else
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, payout_id, source_key)
    values (v_p.merchant_id, 'payout_returned', 'processing', -v_p.amount, v_p.id, 'payout:' || v_p.id || ':returned'),
           (v_p.merchant_id, 'payout_returned', 'available', v_p.amount, v_p.id, 'payout:' || v_p.id || ':reavailable');
  end if;
  perform record_audit_event('merchant.wallet.payout_' || p_outcome, 'wallet_payout', v_p.id, null, 'system', null,
    case when p_outcome = 'paid' then 'success' else 'failed' end,
    jsonb_build_object('merchantId', v_p.merchant_id, 'amount', v_p.amount, 'fee', v_p.fee));
  return jsonb_build_object('payoutId', v_p.id, 'status', p_outcome, 'duplicate', false);
end $$;

-- Switch a merchant to the wallet. Refused while an unpaid checkout exists,
-- because that charge was initialized with the old split settlement.
create or replace function wallet_enable_for_merchant(p_merchant_id text, p_admin_id text)
returns jsonb language plpgsql as $$
declare v_old text;
begin
  select settlement_model into v_old from merchants where id = p_merchant_id for update;
  if not found then raise exception 'merchant not found'; end if;
  if v_old = 'platform_wallet' then return jsonb_build_object('merchantId', p_merchant_id, 'settlementModel', v_old, 'changed', false); end if;
  if v_old <> 'provider_direct' then raise exception 'only provider_direct merchants can move to the wallet'; end if;
  if exists (select 1 from orders where merchant_id = p_merchant_id and status = 'payment_pending') then
    raise exception 'merchant has unpaid checkouts; retry after they complete or expire';
  end if;
  update merchants set settlement_model = 'platform_wallet' where id = p_merchant_id;
  perform record_audit_event('admin.merchant.wallet_enabled', 'merchant', p_merchant_id, p_admin_id, 'admin', null, 'success',
    jsonb_build_object('previousSettlementModel', v_old));
  return jsonb_build_object('merchantId', p_merchant_id, 'settlementModel', 'platform_wallet', 'changed', true);
end $$;
