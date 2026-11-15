-- Security audit fixes for the back office (PR #33).
--
-- H1  Two-person approval could be defeated by one person: anyone able to
--     assign staff roles could make an account they control into an approver.
--     The database now refuses an approval unless the approver holds the
--     required permission through a grant that (a) was NOT assigned by the
--     requester and (b) is at least 7 days old.
-- M1  Append-only records could be emptied with TRUNCATE (row triggers do not
--     fire for it), and an approval row could be INSERTed already approved.

-- ---------------------------------------------------------------------------
-- H1: approver independence
create or replace function admin_approver_is_independent(
  p_approver text, p_requester text, p_capability text
) returns boolean language sql stable set search_path = public, pg_temp as $$
  select exists (
    -- primary role
    select 1 from admin_staff_roles s
     where s.user_id = p_approver and s.status = 'active'
       and s.assigned_by is distinct from p_requester
       and s.assigned_at <= now() - interval '7 days'
       and (s.staff_role = 'owner' or exists (
             select 1 from admin_role_permissions rp
              where rp.role_key = s.staff_role and rp.capability = p_capability))
    union all
    -- additional roles (only count while the primary role is active)
    select 1 from admin_staff_extra_roles e
      join admin_staff_roles s on s.user_id = e.user_id and s.status = 'active'
     where e.user_id = p_approver
       and e.assigned_by is distinct from p_requester
       and e.assigned_at <= now() - interval '7 days'
       and exists (select 1 from admin_role_permissions rp
                    where rp.role_key = e.role_key and rp.capability = p_capability)
  );
$$;
revoke all on function admin_approver_is_independent(text, text, text) from public;

comment on function admin_approver_is_independent(text, text, text) is
  'True when the approver holds p_capability via an active grant not assigned by the requester and at least 7 days old.';

create or replace function admin_dual_approvals_independence_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.decided_by is not null or new.decided_at is not null then
      raise exception 'dual approval requests must be created pending and undecided';
    end if;
    return new;
  end if;
  if old.status = 'pending' and new.status = 'approved'
     and not admin_approver_is_independent(new.decided_by, new.requested_by, new.required_capability) then
    raise exception 'approver is not independent of the requester (role assigned by the requester, or held for less than 7 days)'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists admin_dual_approvals_independence on admin_dual_approvals;
create trigger admin_dual_approvals_independence
  before insert or update on admin_dual_approvals
  for each row execute function admin_dual_approvals_independence_guard();

-- ---------------------------------------------------------------------------
-- M1: append-only records cannot be truncated
create or replace function forbid_truncate_append_only() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception '% is append-only and cannot be truncated', tg_table_name;
end $$;

do $$
declare t text;
begin
  foreach t in array array['audit_events','wallet_ledger_entries','risk_flags','admin_dual_approvals','review_reports']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists %I on %I', t || '_no_truncate', t);
      execute format('create trigger %I before truncate on %I for each statement execute function forbid_truncate_append_only()',
                     t || '_no_truncate', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- M4: blocked checkouts must reach the fraud review queue.
-- The block aborts the checkout transaction, which also rolled back the
-- assessment and its flag. The exception now carries the assessment in DETAIL;
-- the application records it in a separate transaction via
-- record_blocked_checkout_attempt(), whose insert creates the critical flag
-- through the risk_assessments trigger (migration 0232).
create or replace function enforce_checkout_risk_before_order()
returns trigger language plpgsql as $$
declare
  v_risk jsonb;
  v_fingerprint text;
begin
  if new.status <> 'payment_pending' then return new; end if;
  select fingerprint into v_fingerprint from order_idempotency where group_id=new.group_id limit 1;
  if v_fingerprint is null then raise exception 'checkout risk fingerprint missing'; end if;
  v_risk := evaluate_checkout_risk(new.user_id, v_fingerprint, new.product_total, new.grand_total, new.id);
  if v_risk->>'decision' = 'block' then
    raise exception 'checkout blocked by ELEMARKET risk controls'
      using errcode = 'P0001',
            detail = jsonb_build_object(
              'kind', 'elemarket_checkout_block',
              'score', (v_risk->>'score')::int,
              'reasons', coalesce(v_risk->'reasons', '[]'::jsonb),
              'fingerprint', v_fingerprint,
              'amount', new.grand_total,
              'referenceId', new.id)::text;
  end if;
  return new;
end; $$;

create or replace function record_blocked_checkout_attempt(p_user_id text, p_detail jsonb)
returns text language plpgsql set search_path = public, pg_temp as $$
declare
  v_id text := 'ra_' || replace(gen_random_uuid()::text, '-', '');
  v_score int;
begin
  -- Only for the verified session user (set in the same statement by the app).
  if p_user_id is null or p_user_id is distinct from nullif(current_setting('app.user_id', true), '') then
    raise exception 'blocked checkout can only be recorded for the session user';
  end if;
  if p_detail is null or p_detail->>'kind' <> 'elemarket_checkout_block' then
    raise exception 'not a checkout block payload';
  end if;
  v_score := least(100, greatest(0, coalesce((p_detail->>'score')::int, 100)));
  insert into risk_assessments(id, subject_type, subject_id, reference_id, fingerprint, decision, score, reasons, amount)
  values (v_id, 'customer', p_user_id, left(p_detail->>'referenceId', 128), left(p_detail->>'fingerprint', 256),
          'block', v_score,
          case when jsonb_typeof(p_detail->'reasons') = 'array' then p_detail->'reasons' else '[]'::jsonb end,
          nullif(p_detail->>'amount', '')::numeric);
  return v_id;
end; $$;
revoke all on function record_blocked_checkout_attempt(text, jsonb) from public;
