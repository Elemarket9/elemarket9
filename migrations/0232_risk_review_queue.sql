-- Fraud & risk review queue.
--
-- Until now risk_flags were only counted on the owner dashboard and nobody
-- could review them. Worse, migration 0112 rewrote evaluate_checkout_risk()
-- and evaluate_merchant_withdrawal_risk() without the risk_flags inserts that
-- 0051/0060 had added, so since 0112 NOTHING produced a flag: every 'review'
-- decision went only to risk_assessments.
--
-- This migration:
-- 1. Restores flag production without touching the scoring functions: an
--    AFTER INSERT trigger on risk_assessments turns every 'review'/'block'
--    assessment into an open risk flag. Future rewrites of the scoring
--    functions can no longer silently drop flag production. Repeat
--    assessments for the same subject and flag code collapse into the one
--    open flag (occurrence_count / last_seen_at / latest_evidence) instead of
--    flooding the queue.
-- 2. Adds review fields: claim (assigned_to/assigned_at, 30-minute expiry),
--    decision, resolution_note; status stays open/resolved/dismissed and is
--    kept consistent with decision by a CHECK.
-- 3. A guard trigger: flags are append-only; a decided flag can never be
--    reopened or rewritten; only the current claimer (or the Main
--    Administrator) can record a decision; a live claim cannot be stolen.
--    There is deliberately no reopen path: if the same behaviour recurs a new
--    open flag is created, and the decided record stays as evidence.
-- 4. A decision is a record only. It suspends nobody and holds nothing.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function risk_severity_rank(p_severity text) returns integer
language sql immutable parallel safe as $$
  select case p_severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end
$$;

-- Single source of truth for how long a reviewer's claim lasts.
create or replace function risk_flag_claim_ttl() returns interval
language sql immutable parallel safe as $$ select interval '30 minutes' $$;

create or replace function risk_flag_actor_is_owner(p_user_id text) returns boolean
language sql stable as $$
  select exists(
    select 1 from admin_staff_roles a join "user" u on u.id=a.user_id
     where a.user_id=p_user_id and a.staff_role='owner' and a.status='active' and u.role='admin'
  )
$$;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table risk_flags
  add column if not exists assigned_to text references "user"(id),
  add column if not exists assigned_at timestamptz,
  add column if not exists decision text,
  add column if not exists resolution_note text,
  add column if not exists dedupe_key text,
  add column if not exists occurrence_count integer not null default 1,
  add column if not exists last_seen_at timestamptz,
  add column if not exists latest_evidence jsonb;

update risk_flags set last_seen_at=created_at where last_seen_at is null;
alter table risk_flags alter column last_seen_at set default now();
alter table risk_flags alter column last_seen_at set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname='risk_flags_decision_check' and conrelid='risk_flags'::regclass) then
    alter table risk_flags add constraint risk_flags_decision_check
      check (decision is null or decision in ('dismissed_false_positive','confirmed_fraud','confirmed_monitor'));
  end if;
  if not exists (select 1 from pg_constraint where conname='risk_flags_claim_pair' and conrelid='risk_flags'::regclass) then
    alter table risk_flags add constraint risk_flags_claim_pair
      check ((assigned_to is null) = (assigned_at is null));
  end if;
  if not exists (select 1 from pg_constraint where conname='risk_flags_occurrences_positive' and conrelid='risk_flags'::regclass) then
    alter table risk_flags add constraint risk_flags_occurrences_positive check (occurrence_count >= 1);
  end if;
  -- Status and decision must agree, and a decision always has who/when/why.
  -- NOT VALID: any flag resolved before this queue existed (none are expected;
  -- there was no review path) keeps its row untouched, and the guard trigger
  -- below makes such rows immutable anyway. Every new or updated row is checked.
  if not exists (select 1 from pg_constraint where conname='risk_flags_decision_consistent' and conrelid='risk_flags'::regclass) then
    alter table risk_flags add constraint risk_flags_decision_consistent check (
      (status='open' and decision is null and resolved_at is null and resolved_by is null and resolution_note is null)
      or (status='dismissed' and decision='dismissed_false_positive'
          and resolved_at is not null and resolved_by is not null
          and char_length(btrim(resolution_note)) between 12 and 2000)
      or (status='resolved' and decision in ('confirmed_fraud','confirmed_monitor')
          and resolved_at is not null and resolved_by is not null
          and char_length(btrim(resolution_note)) between 12 and 2000)
    ) not valid;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Queue order: open first, critical > high > medium > low, then oldest first.
create index if not exists risk_flags_queue_idx
  on risk_flags (risk_severity_rank(severity), created_at, id) where status='open';
-- History of decided flags, newest decision first.
create index if not exists risk_flags_history_idx
  on risk_flags (resolved_at desc, id) where status<>'open';
create index if not exists risk_flags_code_idx on risk_flags (flag_code, status);
-- One open flag per subject and flag code for system-produced flags.
-- (Rows produced before this migration have no dedupe_key and are unaffected.)
create unique index if not exists risk_flags_one_open_uq
  on risk_flags (dedupe_key) where status='open' and dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------
create or replace function risk_flags_guard() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'risk flags are append-only and cannot be deleted';
  end if;

  if tg_op='INSERT' then
    if new.status <> 'open' or new.assigned_to is not null then
      raise exception 'a risk flag must be created open and unclaimed';
    end if;
    new.last_seen_at := coalesce(new.last_seen_at, new.created_at, now());
    return new;
  end if;

  -- UPDATE
  if old.status <> 'open' then
    raise exception 'risk flag % is already decided and cannot be changed', old.id;
  end if;
  if new.id is distinct from old.id or new.subject_type is distinct from old.subject_type
     or new.subject_id is distinct from old.subject_id or new.flag_code is distinct from old.flag_code
     or new.severity is distinct from old.severity or new.evidence is distinct from old.evidence
     or new.created_at is distinct from old.created_at or new.dedupe_key is distinct from old.dedupe_key then
    raise exception 'risk flag details are immutable';
  end if;
  if new.occurrence_count < old.occurrence_count or new.last_seen_at < old.last_seen_at then
    raise exception 'risk flag occurrence history cannot go backwards';
  end if;

  if new.status = 'open' then
    -- Claim / release / refresh. A live claim held by someone else cannot be taken.
    if new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to
       and old.assigned_to is not null and old.assigned_at > now() - risk_flag_claim_ttl() then
      raise exception 'risk flag is claimed by another reviewer';
    end if;
    if new.assigned_to is not null
       and (new.assigned_to is distinct from old.assigned_to or new.assigned_at is distinct from old.assigned_at) then
      new.assigned_at := now(); -- claim time is the server's clock, never the caller's
    end if;
    return new;
  end if;

  -- Decision (open -> resolved/dismissed).
  if new.assigned_to is distinct from old.assigned_to or new.assigned_at is distinct from old.assigned_at then
    raise exception 'the claim cannot change while recording a decision';
  end if;
  if new.resolved_by is null then
    raise exception 'a risk decision must name the reviewer';
  end if;
  -- coalesce: an unclaimed flag (assigned_to null) must not slip through as NULL.
  if not coalesce(
       (old.assigned_to is not null and new.resolved_by = old.assigned_to
        and old.assigned_at > now() - risk_flag_claim_ttl())
       or risk_flag_actor_is_owner(new.resolved_by),
       false) then
    raise exception 'only the reviewer holding a live claim on this flag may decide it';
  end if;
  new.resolved_at := now();
  new.resolution_note := btrim(new.resolution_note);
  return new;
end $$;

drop trigger if exists risk_flags_guard on risk_flags;
create trigger risk_flags_guard
before insert or update or delete on risk_flags
for each row execute function risk_flags_guard();

-- ---------------------------------------------------------------------------
-- Producer: every review/block assessment becomes (or refreshes) an open flag.
-- ---------------------------------------------------------------------------
create or replace function risk_flag_from_assessment() returns trigger language plpgsql as $$
declare
  v_subject_type text;
  v_code text;
  v_severity text;
  v_evidence jsonb;
begin
  if new.decision not in ('review','block') then return new; end if;
  if new.subject_type = 'customer' then
    v_subject_type := 'customer';
    v_code := case new.decision when 'block' then 'checkout_blocked' else 'checkout_review' end;
  elsif new.subject_type in ('withdrawal','merchant') then
    v_subject_type := 'merchant';
    v_code := case new.decision when 'block' then 'fund_release_blocked' else 'fund_release_review' end;
  else
    return new; -- 'transaction' assessments have no reviewable subject in risk_flags
  end if;
  v_severity := case new.decision when 'block' then 'critical' else 'high' end;
  v_evidence := jsonb_strip_nulls(jsonb_build_object(
    'assessmentId', new.id,
    'referenceId', new.reference_id,
    'reasons', new.reasons,
    'score', new.score,
    'amount', new.amount,
    'currency', new.currency
  ));

  insert into risk_flags(id,subject_type,subject_id,flag_code,severity,status,evidence,dedupe_key,last_seen_at)
  values('rf_'||replace(gen_random_uuid()::text,'-',''), v_subject_type, new.subject_id, v_code, v_severity, 'open',
         v_evidence, v_subject_type||':'||new.subject_id||':'||v_code, now())
  on conflict (dedupe_key) where status='open' and dedupe_key is not null do update
     set occurrence_count = risk_flags.occurrence_count + 1,
         last_seen_at = greatest(risk_flags.last_seen_at, now()),
         latest_evidence = excluded.evidence;
  return new;
end $$;

drop trigger if exists risk_assessments_produce_flag on risk_assessments;
create trigger risk_assessments_produce_flag
after insert on risk_assessments
for each row execute function risk_flag_from_assessment();

comment on table risk_flags is
  'Fraud/risk review queue. Produced from risk_assessments (review/block). Append-only; decisions are final records and never suspend or hold anything by themselves.';
comment on column risk_flags.decision is
  'dismissed_false_positive (status dismissed) | confirmed_fraud / confirmed_monitor (status resolved). Suspension stays with the moderation functions.';
