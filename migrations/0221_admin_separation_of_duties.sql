-- Admin separation of duties.
--
-- 1. Two new allow-listed permissions:
--    admin.overview.view   read-only marketplace overview (control-centre KPIs)
--    admin.finance.payouts manual wallet payout settlement and reconciliation
--    Manual payout settlement used to ride on admin.finance.policy (the same
--    person could set commission and mark money as paid). Existing holders of
--    admin.finance.policy are backfilled so no one loses access on upgrade;
--    the Main Administrator can then split the two duties per role.
-- 2. Two-person approval for high-value money actions taken by staff.
--    A request is recorded by one administrator and executed only when a
--    DIFFERENT administrator approves it. The database refuses a self-approval
--    regardless of application code.

alter table admin_role_permissions drop constraint if exists admin_role_permissions_capability_check;
alter table admin_role_permissions add constraint admin_role_permissions_capability_check check (capability in (
  'admin.full','admin.operations','admin.support',
  'admin.merchants.review','admin.merchants.moderate',
  'admin.customers.moderate','admin.products.moderate','admin.categories.manage',
  'admin.enterprise.manage','admin.providers.manage','admin.financing.manage',
  'admin.campaigns.manage','admin.audit.read','admin.staff.directory',
  'admin.finance.refunds','admin.finance.policy','admin.finance.view',
  'admin.staff.manage',
  'admin.overview.view','admin.finance.payouts'
));

insert into admin_role_permissions(role_key, capability)
select role_key, 'admin.finance.payouts' from admin_role_permissions where capability = 'admin.finance.policy'
on conflict do nothing;

create table if not exists admin_dual_approvals (
  id text primary key check (id ~ '^dap_[a-f0-9]{32}$'),
  action text not null check (action in ('order_refund','wallet_payout_resolution')),
  subject_id text not null check (char_length(subject_id) between 1 and 128),
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'GHS' check (currency ~ '^[A-Z]{3}$'),
  payload jsonb not null default '{}'::jsonb,
  required_capability text not null check (required_capability in ('admin.finance.refunds','admin.finance.payouts')),
  requested_by text not null references "user"(id),
  request_reason text not null check (char_length(btrim(request_reason)) between 12 and 2000),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled','expired','executed','failed')),
  decided_by text references "user"(id),
  decision_note text check (decision_note is null or char_length(btrim(decision_note)) between 12 and 2000),
  decided_at timestamptz,
  execution_error text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '72 hours',
  updated_at timestamptz not null default now(),
  constraint admin_dual_approvals_four_eyes check (decided_by is null or decided_by <> requested_by),
  constraint admin_dual_approvals_decision_complete check (
    (status = 'pending' and decided_by is null and decided_at is null)
    or (status = 'cancelled' and decided_by is null)
    or (status = 'expired' and decided_by is null)
    or (status in ('approved','rejected','executed','failed') and decided_by is not null and decided_at is not null)
  )
);
-- At most one open request per money action and subject: no parallel duplicates.
create unique index if not exists admin_dual_approvals_one_open_uq
  on admin_dual_approvals(action, subject_id) where status in ('pending','approved');
create index if not exists admin_dual_approvals_status_idx on admin_dual_approvals(status, created_at desc);

-- Decisions are final: once decided, the requester/decider/amount/payload cannot be rewritten.
create or replace function admin_dual_approvals_guard() returns trigger language plpgsql as $$
begin
  if new.requested_by is distinct from old.requested_by or new.action is distinct from old.action
     or new.subject_id is distinct from old.subject_id or new.amount is distinct from old.amount
     or new.payload is distinct from old.payload or new.created_at is distinct from old.created_at then
    raise exception 'dual approval request details are immutable';
  end if;
  if old.decided_by is not null and new.decided_by is distinct from old.decided_by then
    raise exception 'dual approval decision is immutable';
  end if;
  if old.status in ('rejected','cancelled','expired','executed','failed') and new.status is distinct from old.status then
    raise exception 'dual approval is already final';
  end if;
  if old.status = 'approved' and new.status not in ('approved','executed','failed') then
    raise exception 'approved request may only be executed';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists admin_dual_approvals_guard on admin_dual_approvals;
create trigger admin_dual_approvals_guard before update on admin_dual_approvals
  for each row execute function admin_dual_approvals_guard();

create or replace function admin_dual_approvals_no_delete() returns trigger language plpgsql as $$
begin raise exception 'dual approval records are append-only'; end $$;
drop trigger if exists admin_dual_approvals_no_delete on admin_dual_approvals;
create trigger admin_dual_approvals_no_delete before delete on admin_dual_approvals
  for each row execute function admin_dual_approvals_no_delete();

comment on table admin_dual_approvals is
  'Four-eyes approvals for high-value staff money actions. Requester and approver must differ (enforced by constraint).';
