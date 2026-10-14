-- v1.79: true multi-location enterprise operating layer.
-- Enterprise is the parent identity; locations are scoped operational nodes.
-- Payment/refund/settlement remain provider-managed and non-custodial.

create table if not exists enterprise_organizations (
  id text primary key,
  merchant_id text not null unique references merchants(id) on delete cascade,
  legal_name text not null check (char_length(trim(legal_name)) between 2 and 240),
  status text not null default 'active' check (status in ('pending','active','suspended','closed')),
  default_currency char(3) not null default 'GHS',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into enterprise_organizations(id,merchant_id,legal_name)
select 'ent_'||replace(m.id,'-',''),m.id,m.name
from merchants m
where m.tier='enterprise'
on conflict (merchant_id) do nothing;

alter table merchant_inventory_locations
  add column if not exists organization_id text references enterprise_organizations(id) on delete cascade,
  add column if not exists location_type text not null default 'warehouse' check (location_type in ('store','warehouse','distribution_center','fulfillment_center','pickup_point','office')),
  add column if not exists latitude double precision check (latitude is null or latitude between -90 and 90),
  add column if not exists longitude double precision check (longitude is null or longitude between -180 and 180),
  add column if not exists timezone text not null default 'Africa/Accra',
  add column if not exists cutoff_time time,
  add column if not exists external_location_key text;

update merchant_inventory_locations l
set organization_id=e.id
from enterprise_organizations e
where e.merchant_id=l.merchant_id and l.organization_id is null;

update merchant_inventory_locations
set external_location_key=coalesce(external_location_id,id)
where external_location_key is null;

create unique index if not exists enterprise_location_external_key_uq
on merchant_inventory_locations(merchant_id,external_location_key)
where external_location_key is not null;
create index if not exists enterprise_location_org_idx on merchant_inventory_locations(organization_id,status,location_type);

create table if not exists enterprise_location_staff (
  id text primary key,
  organization_id text not null references enterprise_organizations(id) on delete cascade,
  user_id text not null,
  location_id text references merchant_inventory_locations(id) on delete cascade,
  role text not null check (role in ('enterprise_admin','operations_manager','location_manager','warehouse_operator','inventory_manager','fulfillment_operator','support_manager','analyst')),
  status text not null default 'active' check (status in ('active','suspended','revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,user_id,location_id,role)
);
create index if not exists enterprise_staff_user_idx on enterprise_location_staff(user_id,status);
create index if not exists enterprise_staff_location_idx on enterprise_location_staff(location_id,status,role);

create or replace function validate_enterprise_location_staff()
returns trigger language plpgsql as $$
begin
  if new.location_id is not null and not exists (
    select 1 from merchant_inventory_locations l
    where l.id=new.location_id and l.organization_id=new.organization_id
  ) then raise exception 'location does not belong to enterprise'; end if;
  return new;
end $$;
drop trigger if exists enterprise_location_staff_guard on enterprise_location_staff;
create trigger enterprise_location_staff_guard
before insert or update of organization_id,location_id on enterprise_location_staff
for each row execute function validate_enterprise_location_staff();

create table if not exists enterprise_inventory_ledger (
  id text primary key,
  organization_id text not null references enterprise_organizations(id) on delete cascade,
  location_id text not null references merchant_inventory_locations(id) on delete restrict,
  product_id text not null references products(id) on delete restrict,
  movement_type text not null check (movement_type in ('receipt','adjustment','reserve','release','ship','return','transfer_out','transfer_in','damage','correction')),
  quantity integer not null check (quantity <> 0),
  reference_type text,
  reference_id text,
  idempotency_key text,
  actor_user_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(organization_id,idempotency_key)
);
create index if not exists enterprise_inventory_ledger_location_idx on enterprise_inventory_ledger(location_id,created_at desc);
create index if not exists enterprise_inventory_ledger_product_idx on enterprise_inventory_ledger(product_id,created_at desc);

create or replace function validate_enterprise_inventory_location()
returns trigger language plpgsql as $$
declare v_org text; v_pm text; v_lm text;
begin
 select merchant_id into v_pm from products where id=new.product_id;
 select organization_id,merchant_id into v_org,v_lm from merchant_inventory_locations where id=new.location_id;
 if v_org is null or v_org is distinct from new.organization_id or v_pm is distinct from v_lm then raise exception 'inventory enterprise/location/product mismatch'; end if;
 return new;
end $$;
drop trigger if exists enterprise_inventory_ledger_guard on enterprise_inventory_ledger;
create trigger enterprise_inventory_ledger_guard
before insert on enterprise_inventory_ledger
for each row execute function validate_enterprise_inventory_location();

create table if not exists enterprise_inventory_transfers (
  id text primary key,
  organization_id text not null references enterprise_organizations(id) on delete cascade,
  product_id text not null references products(id) on delete restrict,
  from_location_id text not null references merchant_inventory_locations(id) on delete restrict,
  to_location_id text not null references merchant_inventory_locations(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status text not null default 'requested' check (status in ('requested','approved','in_transit','received','cancelled')),
  idempotency_key text not null unique,
  requested_by text,
  approved_by text,
  requested_at timestamptz not null default now(),
  received_at timestamptz,
  check (from_location_id <> to_location_id)
);
create index if not exists enterprise_transfer_org_idx on enterprise_inventory_transfers(organization_id,status,requested_at desc);

create or replace function reserve_enterprise_inventory(
  p_organization_id text,p_location_id text,p_product_id text,p_quantity integer,p_reference_id text,p_idempotency_key text
) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v record; v_reserved integer;
begin
 if p_quantity <= 0 then raise exception 'invalid reservation quantity'; end if;
 if p_idempotency_key is null or length(p_idempotency_key)<16 then raise exception 'invalid idempotency key'; end if;
 if exists(select 1 from enterprise_inventory_ledger where organization_id=p_organization_id and idempotency_key=p_idempotency_key) then
   select coalesce(sum(quantity),0)::int into v_reserved from enterprise_inventory_ledger where organization_id=p_organization_id and idempotency_key=p_idempotency_key;
   return v_reserved;
 end if;
 select i.* into v from product_location_inventory i join merchant_inventory_locations l on l.id=i.location_id where i.product_id=p_product_id and i.location_id=p_location_id and l.organization_id=p_organization_id for update;
 if not found then raise exception 'inventory location not found'; end if;
 if v.available - v.reserved - p_quantity < v.safety_stock then raise exception 'insufficient location inventory'; end if;
 update product_location_inventory set reserved=reserved+p_quantity,version=version+1,updated_at=now() where id=v.id;
 insert into enterprise_inventory_ledger(id,organization_id,location_id,product_id,movement_type,quantity,reference_type,reference_id,idempotency_key,actor_user_id)
 values('eil_'||replace(gen_random_uuid()::text,'-',''),p_organization_id,p_location_id,p_product_id,'reserve',p_quantity,'order',p_reference_id,p_idempotency_key,current_setting('app.user_id',true));
 return p_quantity;
end $$;

create or replace function release_enterprise_inventory(
  p_organization_id text,p_location_id text,p_product_id text,p_quantity integer,p_reference_id text,p_idempotency_key text
) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v record;
begin
 if p_quantity <= 0 then raise exception 'invalid release quantity'; end if;
 if exists(select 1 from enterprise_inventory_ledger where organization_id=p_organization_id and idempotency_key=p_idempotency_key) then return 0; end if;
 select i.* into v from product_location_inventory i join merchant_inventory_locations l on l.id=i.location_id where i.product_id=p_product_id and i.location_id=p_location_id and l.organization_id=p_organization_id for update;
 if not found or v.reserved < p_quantity then raise exception 'invalid inventory release'; end if;
 update product_location_inventory set reserved=reserved-p_quantity,version=version+1,updated_at=now() where id=v.id;
 insert into enterprise_inventory_ledger(id,organization_id,location_id,product_id,movement_type,quantity,reference_type,reference_id,idempotency_key,actor_user_id)
 values('eil_'||replace(gen_random_uuid()::text,'-',''),p_organization_id,p_location_id,p_product_id,'release',-p_quantity,'order',p_reference_id,p_idempotency_key,current_setting('app.user_id',true));
 return p_quantity;
end $$;

create table if not exists enterprise_routing_policies (
  id text primary key,
  organization_id text not null references enterprise_organizations(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  priority integer not null default 100 check (priority between 0 and 10000),
  status text not null default 'active' check (status in ('active','inactive')),
  strategy text not null check (strategy in ('nearest','sla','cost','inventory','configured')),
  max_distance_km numeric(8,2) check (max_distance_km is null or max_distance_km > 0),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists enterprise_routing_policy_idx on enterprise_routing_policies(organization_id,status,priority);

create table if not exists enterprise_location_capabilities (
  location_id text not null references merchant_inventory_locations(id) on delete cascade,
  capability text not null check (capability in ('ship','pickup','same_day','next_day','returns','replacement','cross_dock')),
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(location_id,capability)
);

create table if not exists enterprise_location_hours (
  location_id text not null references merchant_inventory_locations(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time,
  closes_at time,
  closed boolean not null default false,
  primary key(location_id,weekday),
  check ((closed and opens_at is null and closes_at is null) or (not closed and opens_at is not null and closes_at is not null))
);

create or replace function assert_enterprise_location_access(p_user_id text,p_location_id text,p_required_role text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_org text;
begin
 select organization_id into v_org from merchant_inventory_locations where id=p_location_id and status='active';
 if v_org is null then raise exception 'location not found'; end if;
 if exists(select 1 from enterprise_location_staff s where s.organization_id=v_org and s.user_id=p_user_id and s.status='active' and s.role='enterprise_admin') then return; end if;
 if p_required_role is not null and exists(select 1 from enterprise_location_staff s where s.organization_id=v_org and s.user_id=p_user_id and s.location_id=p_location_id and s.status='active' and s.role=p_required_role) then return; end if;
 if p_required_role is null and exists(select 1 from enterprise_location_staff s where s.organization_id=v_org and s.user_id=p_user_id and s.location_id=p_location_id and s.status='active') then return; end if;
 raise exception 'enterprise location access denied';
end $$;

revoke all on function reserve_enterprise_inventory(text,text,text,integer,text,text) from public;
revoke all on function release_enterprise_inventory(text,text,text,integer,text,text) from public;
revoke all on function assert_enterprise_location_access(text,text,text) from public;

comment on table enterprise_organizations is 'Parent enterprise identity for multi-branch, warehouse, distribution and fulfillment operations.';
comment on table enterprise_location_staff is 'Location-scoped enterprise RBAC; enterprise_admin has organization-wide visibility.';
comment on table enterprise_inventory_ledger is 'Immutable operational inventory movement ledger for reconciliation and audit.';
comment on table enterprise_inventory_transfers is 'Controlled inter-location inventory movement with idempotency.';
comment on table enterprise_routing_policies is 'Configurable order fulfillment routing policies per enterprise.';
