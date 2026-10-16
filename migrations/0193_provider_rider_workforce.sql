-- Rider invitations are accepted by the person owning an existing verified identity.
-- No provider manager is permitted to create a rider session or password.
create table provider_rider_invitations (
 id text primary key,
 organization_id text not null references partner_organizations(id),
 invited_email text not null,
 full_name text not null check (length(trim(full_name)) between 2 and 160),
 mobile_phone text not null check (mobile_phone ~ '^[+]233[25][0-9]{8}$'),
 staff_reference text,
 rider_type text not null default 'employee' check (rider_type in ('employee','contractor')),
 vehicle_type text,
 vehicle_registration text,
 operating_region text,
 status text not null default 'pending' check (status in ('pending','accepted','cancelled','expired')),
 created_by text not null,
 accepted_by text,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default (now() + interval '14 days'),
 accepted_at timestamptz,
 updated_at timestamptz not null default now()
);
create unique index provider_rider_one_pending_email on provider_rider_invitations(organization_id,lower(invited_email)) where status='pending';
create index provider_rider_invites_lookup on provider_rider_invitations(lower(invited_email),status,expires_at);
create index provider_rider_invites_org on provider_rider_invitations(organization_id,created_at desc);
alter table partner_organization_users drop constraint if exists partner_organization_users_status_check;
alter table partner_organization_users add constraint partner_organization_users_status_check check (status in ('active','suspended','revoked'));
alter table partner_organization_users add column if not exists activated_at timestamptz;
alter table partner_organization_users add column if not exists suspended_at timestamptz;
alter table partner_organization_users add column if not exists revoked_at timestamptz;
alter table partner_organization_users add column if not exists staff_reference text;
create index if not exists partner_rider_member_lookup on partner_organization_users(user_id,organization_id) where role='rider' and status='active';
-- Never permit an unverified identity to accept a workforce invitation.
create or replace function elemarket_guard_rider_identity_verified() returns trigger language plpgsql as $$
begin
 if new.role='rider' and new.status='active' and
   not exists (select 1 from "user" u where u.id=new.user_id and u."emailVerified"=true) then
  raise exception 'active rider requires a verified identity';
 end if;
 return new;
end $$;
drop trigger if exists rider_verified_identity_gate on partner_organization_users;
create trigger rider_verified_identity_gate before insert or update on partner_organization_users
 for each row execute function elemarket_guard_rider_identity_verified();
-- Forbid new handovers following a rider suspension; keep historical receipts intact.
create index if not exists delivery_jobs_rider_workload on delivery_jobs(handover_rider_user_id,updated_at desc) where handover_rider_user_id is not null;
