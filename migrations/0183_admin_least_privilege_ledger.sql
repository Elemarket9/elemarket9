-- Administrator staff grants. Existing active admins retain access on upgrade;
-- newly promoted admin users receive NO privileges until explicitly provisioned.
create table if not exists admin_staff_roles (
  user_id text primary key references "user"(id) on delete restrict,
  staff_role text not null check (staff_role in ('owner','operations','support')),
  status text not null default 'active' check (status in ('active','suspended')),
  assigned_by text references "user"(id),
  assigned_reason text,
  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists admin_staff_roles_status_role_idx on admin_staff_roles(status,staff_role);
-- Migration-time backfill only, NEVER a runtime fallback for unassigned admins.
insert into admin_staff_roles(user_id,staff_role,status,assigned_reason)
select id,'owner','active','Migration of an existing administrator account'
from "user" where role='admin'
on conflict (user_id) do nothing;
-- Do not directly create staff grants outside the reviewed, audited API.
comment on table admin_staff_roles is 'Admin authorization grants: no implicit privileges for newly created admin identities. Bootstrap first owner from trusted deployment only.';
