-- Merchant wallet payout safety (audit repairs to 0216).
--
-- Defects repaired (reproduced on PostgreSQL 16 before this migration):
--  R1  a refund after a withdrawal reservation drove "available" negative.
--  R2  a retried payout used the live destination row, not the one authorized.
--  R3  a provider "paid" report after a recorded failure was ignored, hiding a
--      double payout.
--  R4  providers without idempotent initiation could not be connected.
--  R5  no withdrawal amount or velocity limits.
-- Also: durable payout attempts, explicit uncertain/cancelled states, a webhook
-- inbox, reconciliation exceptions, database-enforced balance invariants, and
-- audited admin resolution that cannot re-run a settled payout.
--
-- Additive only: no financial row is changed except backfilling the new
-- destination snapshot columns of existing payouts from the rows they reference.

-- ---------------------------------------------------------------------------
-- 1. Ledger: a "recovery" bucket instead of negative available balances.
-- A refund that exceeds what is withheld and available is recorded as money the
-- merchant owes (recovery, negative). Later releases repay it first.
alter table wallet_ledger_entries drop constraint wallet_ledger_entries_bucket_check;
alter table wallet_ledger_entries add constraint wallet_ledger_entries_bucket_check
  check (bucket in ('withheld','available','processing','paid_out','fees','recovery'));
alter table wallet_ledger_entries drop constraint wallet_ledger_entries_entry_type_check;
alter table wallet_ledger_entries add constraint wallet_ledger_entries_entry_type_check
  check (entry_type in ('sale','release','refund','payout_requested','payout_paid','payout_fee',
                        'payout_returned','payout_cancelled','late_payout_paid','reclassification'));

-- Repair existing history written under 0216 (defect R1): a negative available
-- balance becomes an explicit amount owed. Value-preserving and auditable: one
-- pair of entries per affected merchant, no existing row is changed.
insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, source_key)
select merchant_id, 'reclassification', b.bucket, b.amount, 'migration-0217:' || merchant_id || ':' || b.bucket
  from (select merchant_id, sum(amount) as available from wallet_ledger_entries where bucket = 'available'
         group by merchant_id having sum(amount) < 0) neg
  cross join lateral (values ('available', -neg.available), ('recovery', neg.available)) as b(bucket, amount);

-- Per-merchant invariants, checked at COMMIT for every transaction that writes
-- the ledger: no negative withheld/available/processing/paid-out/fees, recovery
-- never positive, and every non-earning movement nets to zero.
create or replace function wallet_assert_merchant_invariants() returns trigger language plpgsql as $$
declare v record;
begin
  select coalesce(sum(amount) filter (where bucket='withheld'),0) as withheld,
         coalesce(sum(amount) filter (where bucket='available'),0) as available,
         coalesce(sum(amount) filter (where bucket='processing'),0) as processing,
         coalesce(sum(amount) filter (where bucket='paid_out'),0) as paid_out,
         coalesce(sum(amount) filter (where bucket='fees'),0) as fees,
         coalesce(sum(amount) filter (where bucket='recovery'),0) as recovery,
         coalesce(sum(amount) filter (where entry_type not in ('sale','refund')),0) as moves
    into v from wallet_ledger_entries where merchant_id = new.merchant_id;
  if v.withheld < 0 or v.available < 0 or v.processing < 0 or v.paid_out < 0 or v.fees < 0 or v.recovery > 0 then
    raise exception 'wallet invariant violated for merchant %: withheld %, available %, processing %, paid out %, fees %, recovery %',
      new.merchant_id, v.withheld, v.available, v.processing, v.paid_out, v.fees, v.recovery;
  end if;
  if v.moves <> 0 then
    raise exception 'wallet invariant violated for merchant %: bucket movements do not net to zero (%)', new.merchant_id, v.moves;
  end if;
  return null;
end $$;
drop trigger if exists wallet_ledger_invariants on wallet_ledger_entries;
create constraint trigger wallet_ledger_invariants after insert on wallet_ledger_entries
  deferrable initially deferred for each row execute function wallet_assert_merchant_invariants();

-- Appended columns only (existing view columns keep their order).
create or replace view merchant_wallet_balances as
select m.id as merchant_id,
       coalesce(sum(e.amount) filter (where e.entry_type = 'sale'), 0)::numeric(12,2) as total_sales,
       coalesce(-sum(e.amount) filter (where e.entry_type = 'refund'), 0)::numeric(12,2) as refunded,
       coalesce(sum(e.amount) filter (where e.bucket = 'withheld'), 0)::numeric(12,2) as withheld,
       coalesce(sum(e.amount) filter (where e.bucket = 'available'), 0)::numeric(12,2) as available,
       coalesce(sum(e.amount) filter (where e.bucket = 'processing'), 0)::numeric(12,2) as processing,
       coalesce(sum(e.amount) filter (where e.bucket = 'paid_out'), 0)::numeric(12,2) as paid_out,
       coalesce(sum(e.amount) filter (where e.bucket = 'fees'), 0)::numeric(12,2) as payout_fees,
       coalesce(-sum(e.amount) filter (where e.bucket = 'recovery'), 0)::numeric(12,2) as recovery_due
  from merchants m
  left join wallet_ledger_entries e on e.merchant_id = m.id
 group by m.id;

create or replace function wallet_apply_refund(p_order_id text, p_amount numeric, p_source text)
returns numeric language plpgsql as $$
declare
  v_merchant text;
  v_cap numeric(12,2);
  v_debit numeric(12,2);
  v_withheld numeric(12,2);
  v_available numeric(12,2);
  v_from_withheld numeric(12,2);
  v_from_available numeric(12,2);
  v_owed numeric(12,2);
begin
  select merchant_id into v_merchant from orders where id = p_order_id;
  if v_merchant is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:wallet:' || v_merchant, 0));
  v_cap := wallet_order_refundable(p_order_id);
  v_debit := least(round(coalesce(p_amount, 0), 2), v_cap);
  if v_debit <= 0 then return 0; end if;
  select coalesce(sum(amount), 0) into v_withheld
    from wallet_ledger_entries where order_id = p_order_id and bucket = 'withheld';
  select coalesce(sum(amount), 0) into v_available
    from wallet_ledger_entries where merchant_id = v_merchant and bucket = 'available';
  v_from_withheld := least(v_debit, greatest(v_withheld, 0));
  v_from_available := least(v_debit - v_from_withheld, greatest(v_available, 0));
  v_owed := v_debit - v_from_withheld - v_from_available;
  if v_from_withheld > 0 then
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
    values (v_merchant, 'refund', 'withheld', -v_from_withheld, p_order_id, p_source || ':withheld')
    on conflict (source_key) do nothing;
  end if;
  if v_from_available > 0 then
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
    values (v_merchant, 'refund', 'available', -v_from_available, p_order_id, p_source || ':available')
    on conflict (source_key) do nothing;
  end if;
  if v_owed > 0 then
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
    values (v_merchant, 'refund', 'recovery', -v_owed, p_order_id, p_source || ':recovery')
    on conflict (source_key) do nothing;
  end if;
  return v_debit;
end $$;

-- Release repays any refund recovery first, then the rest becomes available.
create or replace function release_matured_wallet_funds(p_limit integer default 200)
returns integer language plpgsql as $$
declare
  v_row record;
  v_count integer := 0;
  v_withheld numeric(12,2);
  v_owed numeric(12,2);
  v_repay numeric(12,2);
begin
  for v_row in
    select o.id as order_id, o.merchant_id
      from (select e.order_id
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
    -- Re-read under the merchant lock: a refund or another release may have run.
    if exists (select 1 from wallet_ledger_entries where order_id = v_row.order_id and entry_type = 'release') then continue; end if;
    select coalesce(sum(amount), 0) into v_withheld
      from wallet_ledger_entries where order_id = v_row.order_id and bucket = 'withheld';
    if v_withheld <= 0 then continue; end if;
    select coalesce(-sum(amount), 0) into v_owed
      from wallet_ledger_entries where merchant_id = v_row.merchant_id and bucket = 'recovery';
    v_repay := least(v_withheld, greatest(v_owed, 0));
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
    values (v_row.merchant_id, 'release', 'withheld', -v_withheld, v_row.order_id, 'release:' || v_row.order_id || ':withheld');
    if v_repay > 0 then
      insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
      values (v_row.merchant_id, 'release', 'recovery', v_repay, v_row.order_id, 'release:' || v_row.order_id || ':recovery');
    end if;
    if v_withheld - v_repay > 0 then
      insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, order_id, source_key)
      values (v_row.merchant_id, 'release', 'available', v_withheld - v_repay, v_row.order_id, 'release:' || v_row.order_id || ':available');
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Payouts: explicit states, authorized destination snapshot, durable attempts.
--   requested   funds reserved, nothing sent yet           (canonical RESERVED)
--   submitting  an attempt is recorded and may be in flight (crash => uncertain)
--   processing  provider accepted; awaiting final outcome
--   uncertain   outcome of a send is unknown; must be read back before anything else
--   paid / failed / cancelled                                (terminal)
--   needs_attention  quarantined for reconciliation        (canonical RECONCILIATION_REQUIRED)
alter table wallet_payouts drop constraint wallet_payouts_status_check;
alter table wallet_payouts add constraint wallet_payouts_status_check
  check (status in ('requested','submitting','processing','uncertain','paid','failed','cancelled','needs_attention'));
drop index if exists wallet_payouts_one_active_per_merchant;
create unique index wallet_payouts_one_active_per_merchant on wallet_payouts(merchant_id)
  where status in ('requested','submitting','processing','uncertain','needs_attention');

alter table wallet_payouts add column if not exists destination_ref text;
alter table wallet_payouts add column if not exists rail text;
alter table wallet_payouts add column if not exists late_conflict boolean not null default false;
update wallet_payouts w set destination_ref = a.destination_ref, rail = a.rail
  from merchant_payout_accounts a where a.id = w.destination_id and w.destination_ref is null;
alter table wallet_payouts alter column destination_ref set not null;
alter table wallet_payouts alter column rail set not null;
alter table wallet_payouts add constraint wallet_payouts_rail_check check (rail in ('mobile_money','bank'));
comment on column wallet_payouts.destination_ref is
  'Destination token authorized when the withdrawal was requested. Every attempt pays this, never the live account row.';

-- A payout account's destination never changes in place. A new destination is a
-- new account row, which goes through verification and the cooling period.
create or replace function merchant_payout_account_guard() returns trigger language plpgsql as $$
begin
  if new.merchant_id is distinct from old.merchant_id or new.rail is distinct from old.rail
     or new.destination_ref is distinct from old.destination_ref
     or (old.driver_key is not null and new.driver_key is distinct from old.driver_key) then
    raise exception 'payout destination details are immutable; add a new payout account instead';
  end if;
  if old.verified_at is not null and new.verified_at is distinct from old.verified_at then
    raise exception 'payout destination verification time is immutable';
  end if;
  return new;
end $$;
drop trigger if exists merchant_payout_account_immutable on merchant_payout_accounts;
create trigger merchant_payout_account_immutable before update on merchant_payout_accounts
  for each row execute function merchant_payout_account_guard();

create or replace function wallet_payouts_guard() returns trigger language plpgsql as $$
begin
  if new.merchant_id is distinct from old.merchant_id or new.destination_id is distinct from old.destination_id
     or new.destination_ref is distinct from old.destination_ref or new.rail is distinct from old.rail
     or new.amount is distinct from old.amount or new.fee is distinct from old.fee
     or new.driver_key is distinct from old.driver_key or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'withdrawal identity, amount and destination are immutable';
  end if;
  if old.provider_reference is not null and new.provider_reference is distinct from old.provider_reference then
    raise exception 'payout provider reference is immutable once bound';
  end if;
  if old.status in ('paid','failed','cancelled') and new.status is distinct from old.status then
    -- Only the audited late-success path may move failed -> paid.
    if not (old.status = 'failed' and new.status = 'paid' and new.late_conflict) then
      raise exception 'withdrawal % is final (%)', old.id, old.status;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists wallet_payouts_immutable on wallet_payouts;
create trigger wallet_payouts_immutable before update on wallet_payouts
  for each row execute function wallet_payouts_guard();

create table if not exists wallet_payout_attempts (
  id bigserial primary key,
  payout_id text not null references wallet_payouts(id) on delete restrict,
  attempt_no integer not null check (attempt_no > 0),
  driver_key text not null,
  kind text not null check (kind in ('send','lookup')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text not null default 'pending'
    check (outcome in ('pending','accepted','paid','failed','rejected','uncertain','not_found','error')),
  provider_reference text,
  detail text check (detail is null or char_length(detail) <= 500),
  unique (payout_id, attempt_no)
);
comment on table wallet_payout_attempts is
  'Every send and read-back of a payout, recorded BEFORE the provider is called. A send with outcome pending after a crash means the transfer may exist.';

-- Payout provider notifications, de-duplicated by content.
create table if not exists wallet_payout_events (
  id bigserial primary key,
  driver_key text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  payout_id text,
  reported_status text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text,
  unique (driver_key, payload_sha256)
);

create table if not exists wallet_reconciliation_exceptions (
  id bigserial primary key,
  dedupe_key text not null unique,
  kind text not null check (kind in ('late_success_after_failure','failure_after_success','amount_mismatch',
    'currency_mismatch','duplicate_external_payout','unknown_external_payout','missing_at_provider',
    'unverifiable_outcome','invariant_violation')),
  severity text not null check (severity in ('critical','high','medium')),
  payout_id text references wallet_payouts(id) on delete restrict,
  merchant_id text references merchants(id) on delete restrict,
  driver_key text,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  status text not null default 'open' check (status in ('open','resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution text check (resolution is null or char_length(resolution) between 20 and 2000)
);
comment on table wallet_reconciliation_exceptions is
  'Differences between the wallet and the payout provider. Never auto-corrected silently; resolved by staff with a written resolution.';

create or replace function wallet_record_exception(
  p_kind text, p_severity text, p_dedupe text, p_payout_id text, p_driver_key text, p_details jsonb)
returns void language plpgsql as $$
begin
  insert into wallet_reconciliation_exceptions(dedupe_key, kind, severity, payout_id, merchant_id, driver_key, details)
  values (p_dedupe, p_kind, p_severity, p_payout_id,
          (select merchant_id from wallet_payouts where id = p_payout_id), p_driver_key, coalesce(p_details, '{}'::jsonb))
  on conflict (dedupe_key) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Withdrawal request with limits, destination cooldown and snapshot.
drop function if exists wallet_request_payout(text, numeric, numeric, text, text, text, text);
create or replace function wallet_request_payout(
  p_merchant_id text, p_amount numeric, p_fee numeric, p_destination_id text,
  p_driver_key text, p_idempotency_key text, p_requested_by text, p_limits jsonb)
returns jsonb language plpgsql as $$
declare
  v_existing wallet_payouts%rowtype;
  v_available numeric(12,2);
  v_dest record;
  v_id text;
  v_amount numeric(12,2) := round(p_amount, 2);
  v_fee numeric(12,2) := round(coalesce(p_fee, 0), 2);
  v_min numeric(12,2) := coalesce((p_limits->>'minAmount')::numeric, 1);
  v_max numeric(12,2) := coalesce((p_limits->>'maxAmount')::numeric, 50000);
  v_daily_amount numeric(12,2) := coalesce((p_limits->>'dailyAmount')::numeric, 100000);
  v_daily_count integer := coalesce((p_limits->>'dailyCount')::integer, 5);
  v_cooldown interval := make_interval(hours => coalesce((p_limits->>'destinationCooldownHours')::integer, 24));
  v_day_amount numeric(12,2);
  v_day_count integer;
begin
  if p_merchant_id is null or p_requested_by is null then raise exception 'merchant required'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 16 and 128 then raise exception 'invalid idempotency key'; end if;
  if v_amount is null or v_amount <= 0 or v_amount <> p_amount then raise exception 'invalid payout amount'; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:wallet:' || p_merchant_id, 0));

  -- Replay first: the same request returns the same withdrawal, whatever happened since.
  select * into v_existing from wallet_payouts where merchant_id = p_merchant_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.amount <> v_amount or v_existing.destination_id <> p_destination_id then raise exception 'idempotency conflict'; end if;
    return jsonb_build_object('payoutId', v_existing.id, 'status', v_existing.status, 'replay', true);
  end if;

  if v_fee < 0 or v_fee >= v_amount then raise exception 'payout amount must exceed the transfer fee'; end if;
  if v_amount < v_min then raise exception 'withdrawal below the minimum of %', v_min; end if;
  if v_amount > v_max then raise exception 'withdrawal above the maximum of %', v_max; end if;
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
  if coalesce(v_dest.verified_at, v_dest.created_at) > now() - v_cooldown then
    raise exception 'new payout destination is in its security cooling period';
  end if;
  if exists (select 1 from wallet_payouts where merchant_id = p_merchant_id
              and status in ('requested','submitting','processing','uncertain','needs_attention')) then
    raise exception 'a withdrawal is already in progress';
  end if;
  select coalesce(sum(amount) filter (where status not in ('failed','cancelled')), 0), count(*)
    into v_day_amount, v_day_count
    from wallet_payouts where merchant_id = p_merchant_id and created_at > now() - interval '24 hours';
  if v_day_count >= v_daily_count then raise exception 'daily withdrawal count limit reached'; end if;
  if v_day_amount + v_amount > v_daily_amount then raise exception 'daily withdrawal amount limit reached'; end if;
  select coalesce(sum(amount), 0) into v_available
    from wallet_ledger_entries where merchant_id = p_merchant_id and bucket = 'available';
  if v_amount > v_available then raise exception 'amount exceeds available balance'; end if;

  v_id := 'wpo_' || replace(gen_random_uuid()::text, '-', '');
  insert into wallet_payouts(id, merchant_id, destination_id, destination_ref, rail, amount, fee, driver_key, idempotency_key, requested_by)
  values (v_id, p_merchant_id, p_destination_id, v_dest.destination_ref, v_dest.rail, v_amount, v_fee, p_driver_key, p_idempotency_key, p_requested_by);
  insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, payout_id, source_key)
  values (p_merchant_id, 'payout_requested', 'available', -v_amount, v_id, 'payout:' || v_id || ':available'),
         (p_merchant_id, 'payout_requested', 'processing', v_amount, v_id, 'payout:' || v_id || ':processing');
  perform record_audit_event('merchant.wallet.payout_requested', 'wallet_payout', v_id, p_requested_by, 'merchant', null, 'success',
    jsonb_build_object('merchantId', p_merchant_id, 'amount', v_amount, 'fee', v_fee, 'destinationId', p_destination_id));
  return jsonb_build_object('payoutId', v_id, 'status', 'requested', 'amount', v_amount, 'fee', v_fee,
                            'netAmount', v_amount - v_fee, 'replay', false);
end $$;

-- Merchant cancels a withdrawal that has never been sent.
create or replace function wallet_cancel_payout(p_payout_id text, p_merchant_id text, p_actor text)
returns jsonb language plpgsql as $$
declare v_p wallet_payouts%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('elemarket:wallet:' || p_merchant_id, 0));
  select * into v_p from wallet_payouts where id = p_payout_id and merchant_id = p_merchant_id for update;
  if not found then raise exception 'withdrawal not found'; end if;
  if v_p.status = 'cancelled' then return jsonb_build_object('payoutId', v_p.id, 'status', 'cancelled', 'duplicate', true); end if;
  if v_p.status <> 'requested' or exists (select 1 from wallet_payout_attempts where payout_id = v_p.id and kind = 'send')
     or (v_p.lease_until is not null and v_p.lease_until > now()) then
    raise exception 'withdrawal has already been sent and can no longer be cancelled';
  end if;
  update wallet_payouts set status = 'cancelled', completed_at = now(), updated_at = now() where id = v_p.id;
  insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, payout_id, source_key)
  values (v_p.merchant_id, 'payout_cancelled', 'processing', -v_p.amount, v_p.id, 'payout:' || v_p.id || ':cancelled'),
         (v_p.merchant_id, 'payout_cancelled', 'available', v_p.amount, v_p.id, 'payout:' || v_p.id || ':uncancelled');
  perform record_audit_event('merchant.wallet.payout_cancelled', 'wallet_payout', v_p.id, p_actor, 'merchant', null, 'success',
    jsonb_build_object('merchantId', v_p.merchant_id, 'amount', v_p.amount));
  return jsonb_build_object('payoutId', v_p.id, 'status', 'cancelled', 'duplicate', false);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Durable attempts. begin: requested/uncertain -> submitting, BEFORE any send.
create or replace function wallet_begin_send(p_payout_id text, p_lease text)
returns jsonb language plpgsql as $$
declare v_p wallet_payouts%rowtype; v_no integer;
begin
  select * into v_p from wallet_payouts where id = p_payout_id for update;
  if not found or v_p.lease_token is distinct from p_lease or v_p.status not in ('requested','uncertain') then
    return jsonb_build_object('ok', false);
  end if;
  select coalesce(max(attempt_no), 0) + 1 into v_no from wallet_payout_attempts where payout_id = v_p.id;
  insert into wallet_payout_attempts(payout_id, attempt_no, driver_key, kind) values (v_p.id, v_no, v_p.driver_key, 'send');
  update wallet_payouts set status = 'submitting', updated_at = now() where id = v_p.id;
  return jsonb_build_object('ok', true, 'attemptNo', v_no,
    'sends', (select count(*) from wallet_payout_attempts where payout_id = v_p.id and kind = 'send'));
end $$;

create or replace function wallet_record_attempt(
  p_payout_id text, p_attempt_no integer, p_kind text, p_outcome text, p_provider_reference text, p_detail text)
returns void language plpgsql as $$
begin
  if p_attempt_no is null then
    insert into wallet_payout_attempts(payout_id, attempt_no, driver_key, kind, finished_at, outcome, provider_reference, detail)
    select p_payout_id, coalesce(max(a.attempt_no), 0) + 1, w.driver_key, p_kind, now(), p_outcome, p_provider_reference, left(p_detail, 500)
      from wallet_payouts w left join wallet_payout_attempts a on a.payout_id = w.id
     where w.id = p_payout_id group by w.driver_key;
  else
    update wallet_payout_attempts set finished_at = now(), outcome = p_outcome,
           provider_reference = coalesce(p_provider_reference, provider_reference), detail = left(p_detail, 500)
     where payout_id = p_payout_id and attempt_no = p_attempt_no;
  end if;
end $$;

-- A send whose outcome is unknown. Never treated as failure.
create or replace function wallet_mark_uncertain(p_payout_id text, p_lease text, p_reason text, p_retry_after_seconds integer)
returns void language plpgsql as $$
begin
  update wallet_payouts set status = 'uncertain', failure_reason = left(p_reason, 500), lease_token = null, lease_until = null,
         next_attempt_at = now() + make_interval(secs => greatest(5, least(coalesce(p_retry_after_seconds, 60), 3600))),
         updated_at = now()
   where id = p_payout_id and status in ('submitting','uncertain','requested') and (p_lease is null or lease_token = p_lease);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Outcome. Terminal states are final; a contradicting provider report is
-- never ignored: it is recorded, and a late success after a recorded failure is
-- booked (funds that were returned are taken back) so they cannot be paid twice.
drop function if exists wallet_settle_payout(text, text, text, text);
create or replace function wallet_settle_payout(
  p_payout_id text, p_outcome text, p_provider_reference text, p_reason text default null,
  p_reported_amount numeric default null, p_source text default 'provider')
returns jsonb language plpgsql as $$
declare
  v_p wallet_payouts%rowtype;
  v_available numeric(12,2);
  v_take numeric(12,2);
begin
  if p_outcome not in ('accepted','paid','failed','needs_attention') then raise exception 'invalid payout outcome'; end if;
  select merchant_id into v_p.merchant_id from wallet_payouts where id = p_payout_id;
  if not found then raise exception 'payout not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:wallet:' || v_p.merchant_id, 0));
  select * into v_p from wallet_payouts where id = p_payout_id for update;

  if p_reported_amount is not null and p_outcome in ('accepted','paid') and round(p_reported_amount, 2) <> v_p.net_amount then
    perform wallet_record_exception('amount_mismatch', 'critical', 'amount:' || v_p.id || ':' || p_reported_amount, v_p.id, v_p.driver_key,
      jsonb_build_object('expectedNet', v_p.net_amount, 'reported', p_reported_amount, 'providerReference', p_provider_reference));
    if v_p.status not in ('paid','failed','cancelled') then
      update wallet_payouts set status = 'needs_attention', failure_reason = 'Provider amount differs from the withdrawal',
             provider_reference = coalesce(provider_reference, p_provider_reference), lease_token = null, lease_until = null, updated_at = now()
       where id = v_p.id;
    end if;
    return jsonb_build_object('payoutId', v_p.id, 'status', 'needs_attention', 'exception', 'amount_mismatch');
  end if;

  if v_p.status = 'paid' then
    if p_outcome = 'failed' then
      perform wallet_record_exception('failure_after_success', 'critical', 'paid-then-failed:' || v_p.id, v_p.id, v_p.driver_key,
        jsonb_build_object('providerReference', coalesce(p_provider_reference, v_p.provider_reference), 'reason', p_reason, 'source', p_source));
    end if;
    return jsonb_build_object('payoutId', v_p.id, 'status', 'paid', 'duplicate', true);
  end if;
  if v_p.status = 'cancelled' then
    if p_outcome in ('accepted','paid') then
      perform wallet_record_exception('unknown_external_payout', 'critical', 'cancelled-paid:' || v_p.id, v_p.id, v_p.driver_key,
        jsonb_build_object('providerReference', p_provider_reference, 'source', p_source));
    end if;
    return jsonb_build_object('payoutId', v_p.id, 'status', 'cancelled', 'duplicate', true);
  end if;
  if v_p.status = 'failed' then
    if p_outcome <> 'paid' then
      return jsonb_build_object('payoutId', v_p.id, 'status', 'failed', 'duplicate', true);
    end if;
    -- The provider paid a withdrawal we had recorded as failed and returned.
    -- Book the payment: take the money back from available, and record the
    -- rest as owed (recovery), so it cannot be withdrawn a second time.
    select coalesce(sum(amount), 0) into v_available from wallet_ledger_entries where merchant_id = v_p.merchant_id and bucket = 'available';
    v_take := least(v_p.amount, greatest(v_available, 0));
    if v_take > 0 then
      insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, payout_id, source_key)
      values (v_p.merchant_id, 'late_payout_paid', 'available', -v_take, v_p.id, 'payout:' || v_p.id || ':late:available');
    end if;
    if v_p.amount - v_take > 0 then
      insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, payout_id, source_key)
      values (v_p.merchant_id, 'late_payout_paid', 'recovery', -(v_p.amount - v_take), v_p.id, 'payout:' || v_p.id || ':late:recovery');
    end if;
    insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, payout_id, source_key)
    values (v_p.merchant_id, 'late_payout_paid', 'paid_out', v_p.net_amount, v_p.id, 'payout:' || v_p.id || ':late:paid_out');
    if v_p.fee > 0 then
      insert into wallet_ledger_entries(merchant_id, entry_type, bucket, amount, payout_id, source_key)
      values (v_p.merchant_id, 'late_payout_paid', 'fees', v_p.fee, v_p.id, 'payout:' || v_p.id || ':late:fee');
    end if;
    update wallet_payouts set status = 'paid', late_conflict = true, completed_at = now(), updated_at = now(),
           provider_reference = coalesce(provider_reference, p_provider_reference) where id = v_p.id;
    perform wallet_record_exception('late_success_after_failure', 'critical', 'late-success:' || v_p.id, v_p.id, v_p.driver_key,
      jsonb_build_object('amount', v_p.amount, 'takenFromAvailable', v_take, 'owedByMerchant', v_p.amount - v_take,
                         'providerReference', p_provider_reference, 'source', p_source));
    return jsonb_build_object('payoutId', v_p.id, 'status', 'paid', 'lateConflict', true);
  end if;

  if v_p.provider_reference is not null and p_provider_reference is not null and v_p.provider_reference <> p_provider_reference then
    perform wallet_record_exception('duplicate_external_payout', 'critical', 'ref:' || v_p.id || ':' || p_provider_reference, v_p.id, v_p.driver_key,
      jsonb_build_object('boundReference', v_p.provider_reference, 'reportedReference', p_provider_reference, 'source', p_source));
    update wallet_payouts set status = 'needs_attention', failure_reason = 'Provider reported a second transfer reference',
           lease_token = null, lease_until = null, updated_at = now() where id = v_p.id;
    return jsonb_build_object('payoutId', v_p.id, 'status', 'needs_attention', 'exception', 'duplicate_external_payout');
  end if;

  if p_outcome = 'accepted' then
    update wallet_payouts set status = 'processing', provider_reference = coalesce(provider_reference, p_provider_reference),
           failure_reason = null, lease_token = null, lease_until = null, updated_at = now()
     where id = v_p.id and status in ('requested','submitting','uncertain','processing');
    return jsonb_build_object('payoutId', v_p.id, 'status', 'processing');
  end if;
  if p_outcome = 'needs_attention' then
    update wallet_payouts set status = 'needs_attention', failure_reason = left(p_reason, 500),
           provider_reference = coalesce(provider_reference, p_provider_reference), lease_token = null, lease_until = null, updated_at = now()
     where id = v_p.id;
    perform wallet_record_exception('unverifiable_outcome', 'high', 'attention:' || v_p.id || ':' || md5(coalesce(p_reason, '')), v_p.id, v_p.driver_key,
      jsonb_build_object('reason', p_reason, 'source', p_source));
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
    jsonb_build_object('merchantId', v_p.merchant_id, 'amount', v_p.amount, 'fee', v_p.fee, 'source', p_source));
  return jsonb_build_object('payoutId', v_p.id, 'status', p_outcome, 'duplicate', false);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Admin resolution: only quarantined or uncertain withdrawals, with written
-- evidence; a settled withdrawal can never be re-run or re-decided.
create or replace function wallet_admin_resolve_payout(
  p_payout_id text, p_outcome text, p_admin_id text, p_evidence text, p_provider_reference text default null)
returns jsonb language plpgsql as $$
declare v_status text; v_result jsonb;
begin
  if p_outcome not in ('paid','failed','requeue') then raise exception 'invalid resolution'; end if;
  if p_evidence is null or char_length(trim(p_evidence)) < 20 then raise exception 'written evidence of the provider outcome is required'; end if;
  select status into v_status from wallet_payouts where id = p_payout_id for update;
  if not found then raise exception 'withdrawal not found'; end if;
  if v_status not in ('needs_attention','uncertain') then
    raise exception 'withdrawal is % and cannot be resolved or retried by staff', v_status;
  end if;
  if p_outcome = 'requeue' then
    -- Back to "uncertain": the next run must read the provider back before any resend.
    update wallet_payouts set status = 'uncertain', next_attempt_at = now(), lease_token = null, lease_until = null, updated_at = now()
     where id = p_payout_id;
    v_result := jsonb_build_object('payoutId', p_payout_id, 'status', 'uncertain');
  else
    v_result := wallet_settle_payout(p_payout_id, p_outcome, p_provider_reference, 'Resolved by staff: ' || left(p_evidence, 400), null, 'admin');
  end if;
  perform record_audit_event('admin.wallet.payout_resolved', 'wallet_payout', p_payout_id, p_admin_id, 'admin', null, 'success',
    jsonb_build_object('outcome', p_outcome, 'previousStatus', v_status, 'evidence', left(p_evidence, 1000)));
  update wallet_reconciliation_exceptions set status = 'resolved', resolved_at = now(), resolved_by = p_admin_id,
         resolution = left('Withdrawal resolved as ' || p_outcome || ': ' || p_evidence, 2000)
   where payout_id = p_payout_id and status = 'open' and kind in ('unverifiable_outcome','missing_at_provider');
  return v_result;
end $$;

create or replace function wallet_resolve_exception(p_exception_id bigint, p_admin_id text, p_resolution text)
returns void language plpgsql as $$
begin
  if p_resolution is null or char_length(trim(p_resolution)) < 20 then raise exception 'a written resolution is required'; end if;
  update wallet_reconciliation_exceptions set status = 'resolved', resolved_at = now(), resolved_by = p_admin_id, resolution = left(p_resolution, 2000)
   where id = p_exception_id and status = 'open';
  if not found then raise exception 'exception not found or already resolved'; end if;
  perform record_audit_event('admin.wallet.exception_resolved', 'wallet_exception', p_exception_id::text, p_admin_id, 'admin', null, 'success',
    jsonb_build_object('resolution', left(p_resolution, 1000)));
end $$;

-- ---------------------------------------------------------------------------
-- 7. Reconciliation view of the whole platform-wallet money flow.
create or replace function wallet_reconciliation_summary() returns jsonb language sql stable as $$
  with charges as (
    select p.amount, o.product_total, o.delivery_total, o.platform_fee, o.merchant_net, p.status
      from payments p join orders o on o.id = p.order_id
     where p.settlement_model = 'platform_wallet' and p.status in ('completed','refunded')),
  ledger as (select bucket, entry_type, sum(amount) as amount from wallet_ledger_entries group by bucket, entry_type),
  payouts as (select status, count(*) as n, sum(amount) as amount, sum(net_amount) as net, sum(fee) as fee from wallet_payouts group by status)
  select jsonb_build_object(
    'customerCollections', (select coalesce(sum(amount), 0) from charges),
    'deliveryFees', (select coalesce(sum(delivery_total), 0) from charges),
    'marketplaceCommission', (select coalesce(sum(platform_fee), 0) from charges),
    'merchantEntitlements', (select coalesce(sum(amount), 0) from ledger where entry_type = 'sale'),
    'merchantRefundDebits', (select coalesce(-sum(amount), 0) from ledger where entry_type = 'refund'),
    'buckets', (select jsonb_object_agg(bucket, total) from (select bucket, sum(amount) as total from ledger group by bucket) b),
    'payoutsByStatus', (select coalesce(jsonb_object_agg(status, jsonb_build_object('count', n, 'amount', amount, 'net', net, 'fees', fee)), '{}'::jsonb) from payouts),
    'openExceptions', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) as n from wallet_reconciliation_exceptions where status = 'open' group by kind) e),
    'invariantViolations', (
      select count(*) from merchant_wallet_balances
       where withheld < 0 or available < 0 or processing < 0 or paid_out < 0 or payout_fees < 0 or recovery_due < 0
          or round(withheld + available + processing + paid_out + payout_fees - recovery_due, 2) <> round(total_sales - refunded, 2)))
$$;
