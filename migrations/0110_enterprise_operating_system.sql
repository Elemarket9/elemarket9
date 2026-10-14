-- v1.80: enterprise operating system hardening.
-- Adds service centers, serialized electronics readiness, fulfillment allocations,
-- ERP/POS/WMS connector lifecycle, deterministic routing decisions and atomic transfers.

alter table enterprise_api_clients
  add column if not exists organization_id text references enterprise_organizations(id) on delete cascade,
  add column if not exists location_id text references merchant_inventory_locations(id) on delete restrict;

update enterprise_api_clients c
set organization_id=e.id
from enterprise_organizations e
where e.merchant_id=c.merchant_id and c.organization_id is null;

create index if not exists enterprise_api_clients_org_idx
  on enterprise_api_clients(organization_id,status,location_id);

create or replace function validate_enterprise_api_client_scope()
returns trigger language plpgsql as $$
declare v_org text; v_merchant text;
begin
  select organization_id,merchant_id into v_org,v_merchant
  from merchant_inventory_locations where id=new.location_id;
  if new.location_id is not null and (v_org is null or v_org is distinct from new.organization_id or v_merchant is distinct from new.merchant_id) then
    raise exception 'enterprise API location mismatch';
  end if;
  if new.organization_id is not null and not exists(select 1 from enterprise_organizations e where e.id=new.organization_id and e.merchant_id=new.merchant_id and e.status='active') then
    raise exception 'enterprise API organization mismatch';
  end if;
  return new;
end $$;
drop trigger if exists enterprise_api_client_scope_guard on enterprise_api_clients;
create trigger enterprise_api_client_scope_guard
before insert or update of merchant_id,organization_id,location_id on enterprise_api_clients
for each row execute function validate_enterprise_api_client_scope();

-- -----------------------------------------------------------------------------
-- 1. Serialized electronics / warranty identity.
-- -----------------------------------------------------------------------------
create table if not exists enterprise_serial_units (
  id text primary key,
  organization_id text not null references enterprise_organizations(id) on delete cascade,
  product_id text not null references products(id) on delete restrict,
  location_id text references merchant_inventory_locations(id) on delete restrict,
  serial_number text,
  imei text,
  imei2 text,
  status text not null default 'in_stock' check (status in ('in_stock','reserved','sold','returned','service','quarantined','lost','retired')),
  order_id text references orders(id) on delete set null,
  sold_at timestamptz,
  warranty_expires_at timestamptz,
  external_unit_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (serial_number is not null or imei is not null)
);
create unique index if not exists enterprise_serial_units_serial_uq on enterprise_serial_units(organization_id,serial_number) where serial_number is not null;
create unique index if not exists enterprise_serial_units_imei_uq on enterprise_serial_units(organization_id,imei) where imei is not null;
create unique index if not exists enterprise_serial_units_external_uq on enterprise_serial_units(organization_id,external_unit_key) where external_unit_key is not null;
create index if not exists enterprise_serial_units_product_idx on enterprise_serial_units(product_id,status,location_id);

create or replace function validate_enterprise_serial_unit()
returns trigger language plpgsql as $$
declare v_org text; v_merchant text;
begin
  select organization_id,merchant_id into v_org,v_merchant from merchant_inventory_locations where id=new.location_id;
  if new.location_id is not null and v_org is distinct from new.organization_id then raise exception 'serial unit location organization mismatch'; end if;
  if not exists(select 1 from products p where p.id=new.product_id and p.merchant_id=v_merchant or (new.location_id is null and p.id=new.product_id and p.merchant_id=(select merchant_id from enterprise_organizations where id=new.organization_id))) then
    raise exception 'serial unit product organization mismatch';
  end if;
  return new;
end $$;
drop trigger if exists enterprise_serial_unit_guard on enterprise_serial_units;
create trigger enterprise_serial_unit_guard
before insert or update of organization_id,product_id,location_id on enterprise_serial_units
for each row execute function validate_enterprise_serial_unit();

-- -----------------------------------------------------------------------------
-- 2. Fulfillment allocation graph. An order item may be allocated across nodes.
-- -----------------------------------------------------------------------------
create table if not exists enterprise_fulfillment_allocations (
  id text primary key,
  organization_id text not null references enterprise_organizations(id) on delete cascade,
  order_item_id bigint not null references order_items(id) on delete restrict,
  location_id text not null references merchant_inventory_locations(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status text not null default 'reserved' check (status in ('planned','reserved','released','packed','shipped','delivered','cancelled')),
  routing_policy_id text references enterprise_routing_policies(id) on delete set null,
  decision_reason jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists enterprise_fulfillment_alloc_order_idx on enterprise_fulfillment_allocations(order_item_id,status);
create index if not exists enterprise_fulfillment_alloc_location_idx on enterprise_fulfillment_allocations(location_id,status,created_at desc);

create or replace function validate_enterprise_fulfillment_allocation()
returns trigger language plpgsql as $$
declare v_org text; v_merchant text; v_order text; v_item_qty integer; v_alloc integer;
begin
  select merchant_id into v_merchant from orders o join order_items oi on oi.order_id=o.id where oi.id=new.order_item_id;
  select organization_id,merchant_id into v_org,v_merchant from merchant_inventory_locations where id=new.location_id;
  if v_org is distinct from new.organization_id then raise exception 'allocation organization mismatch'; end if;
  if v_merchant is null then raise exception 'order item not found'; end if;
  select quantity into v_item_qty from order_items where id=new.order_item_id;
  select coalesce(sum(quantity),0)::int into v_alloc from enterprise_fulfillment_allocations where order_item_id=new.order_item_id and status not in ('released','cancelled') and id<>coalesce(new.id,'');
  if v_alloc + new.quantity > v_item_qty then raise exception 'fulfillment allocation exceeds ordered quantity'; end if;
  return new;
end $$;
drop trigger if exists enterprise_fulfillment_allocation_guard on enterprise_fulfillment_allocations;
create trigger enterprise_fulfillment_allocation_guard
before insert or update of order_item_id,location_id,quantity,status on enterprise_fulfillment_allocations
for each row execute function validate_enterprise_fulfillment_allocation();

-- -----------------------------------------------------------------------------
-- 3. Deterministic routing decisions for auditability/replay.
-- -----------------------------------------------------------------------------
create table if not exists enterprise_routing_decisions (
  id text primary key,
  organization_id text not null references enterprise_organizations(id) on delete cascade,
  order_id text not null references orders(id) on delete restrict,
  order_item_id bigint references order_items(id) on delete restrict,
  destination_city text,
  destination_latitude double precision,
  destination_longitude double precision,
  selected_location_id text references merchant_inventory_locations(id) on delete restrict,
  candidate_locations jsonb not null default '[]'::jsonb,
  policy_id text references enterprise_routing_policies(id) on delete set null,
  decision_hash text not null,
  created_at timestamptz not null default now(),
  unique(order_id,order_item_id)
);
create index if not exists enterprise_routing_decision_org_idx on enterprise_routing_decisions(organization_id,created_at desc);

-- -----------------------------------------------------------------------------
-- 4. ERP/POS/WMS connectors and synchronization runs.
-- -----------------------------------------------------------------------------
create table if not exists enterprise_integrations (
  id text primary key,
  organization_id text not null references enterprise_organizations(id) on delete cascade,
  location_id text references merchant_inventory_locations(id) on delete restrict,
  integration_type text not null check (integration_type in ('erp','pos','wms','carrier','service_center','catalog_feed')),
  provider_key text not null check (char_length(trim(provider_key)) between 2 and 120),
  display_name text not null check (char_length(trim(display_name)) between 2 and 160),
  status text not null default 'pending' check (status in ('pending','active','degraded','suspended','revoked')),
  credential_ref text,
  config jsonb not null default '{}'::jsonb,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists enterprise_integrations_org_idx on enterprise_integrations(organization_id,status,integration_type);

create table if not exists enterprise_sync_runs (
  id text primary key,
  integration_id text not null references enterprise_integrations(id) on delete cascade,
  generation bigint not null check (generation >= 0),
  direction text not null check (direction in ('inbound','outbound')),
  resource_type text not null check (resource_type in ('catalog','inventory','orders','shipments','returns','service_cases')),
  status text not null default 'running' check (status in ('running','completed','partial','failed','cancelled')),
  cursor_value text,
  records_seen integer not null default 0 check (records_seen >= 0),
  records_applied integer not null default 0 check (records_applied >= 0),
  records_failed integer not null default 0 check (records_failed >= 0),
  payload_hash text,
  error_summary text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists enterprise_sync_generation_uq on enterprise_sync_runs(integration_id,generation,direction,resource_type);
create index if not exists enterprise_sync_runs_status_idx on enterprise_sync_runs(integration_id,status,started_at desc);

create table if not exists enterprise_sync_events (
  id text primary key,
  integration_id text not null references enterprise_integrations(id) on delete cascade,
  sync_run_id text references enterprise_sync_runs(id) on delete set null,
  external_event_id text,
  idempotency_key text not null,
  resource_type text not null,
  resource_key text,
  payload_hash text not null,
  status text not null default 'received' check (status in ('received','applied','ignored','failed','dead_letter')),
  error_code text,
  created_at timestamptz not null default now(),
  unique(integration_id,idempotency_key),
  unique(integration_id,external_event_id)
);
create index if not exists enterprise_sync_events_resource_idx on enterprise_sync_events(integration_id,resource_type,resource_key,created_at desc);

-- -----------------------------------------------------------------------------
-- 5. After-sales service centers/cases, kept separate from fulfillment nodes.
-- -----------------------------------------------------------------------------
create table if not exists enterprise_service_cases (
  id text primary key,
  organization_id text not null references enterprise_organizations(id) on delete cascade,
  customer_user_id text not null,
  order_id text references orders(id) on delete set null,
  order_item_id bigint references order_items(id) on delete set null,
  product_id text references products(id) on delete set null,
  serial_unit_id text references enterprise_serial_units(id) on delete set null,
  service_location_id text references merchant_inventory_locations(id) on delete set null,
  case_type text not null check (case_type in ('warranty','repair','replacement','installation','inspection','recall')),
  status text not null default 'open' check (status in ('open','triaged','assigned','in_service','awaiting_customer','resolved','rejected','cancelled')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  issue_summary text not null check (char_length(trim(issue_summary)) between 5 and 2000),
  external_case_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists enterprise_service_case_external_uq on enterprise_service_cases(organization_id,external_case_key) where external_case_key is not null;
create index if not exists enterprise_service_case_customer_idx on enterprise_service_cases(customer_user_id,created_at desc);
create index if not exists enterprise_service_case_org_idx on enterprise_service_cases(organization_id,status,priority,created_at desc);

-- -----------------------------------------------------------------------------
-- 6. Atomic inventory transfer completion.
-- -----------------------------------------------------------------------------
create or replace function receive_enterprise_inventory_transfer(
  p_organization_id text,p_transfer_id text,p_user_id text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare t record; src record; dst record;
begin
  select * into t from enterprise_inventory_transfers where id=p_transfer_id and organization_id=p_organization_id for update;
  if not found then raise exception 'transfer not found'; end if;
  if t.status not in ('requested','approved','in_transit') then raise exception 'transfer cannot be received'; end if;
  perform assert_enterprise_location_access(p_user_id,t.from_location_id,null);
  perform assert_enterprise_location_access(p_user_id,t.to_location_id,null);
  select * into src from product_location_inventory where product_id=t.product_id and location_id=t.from_location_id for update;
  if not found or src.available-src.reserved-t.quantity < src.safety_stock then raise exception 'insufficient source inventory'; end if;
  select * into dst from product_location_inventory where product_id=t.product_id and location_id=t.to_location_id for update;
  if not found then
    insert into product_location_inventory(id,product_id,location_id,available,reserved,safety_stock,version,updated_at)
    values('pli_'||replace(gen_random_uuid()::text,'-',''),t.product_id,t.to_location_id,0,0,0,0,now())
    returning * into dst;
  end if;
  update product_location_inventory set available=available-t.quantity,version=version+1,updated_at=now() where id=src.id;
  update product_location_inventory set available=available+t.quantity,version=version+1,updated_at=now() where id=dst.id;
  insert into enterprise_inventory_ledger(id,organization_id,location_id,product_id,movement_type,quantity,reference_type,reference_id,idempotency_key,actor_user_id)
  values('eil_'||replace(gen_random_uuid()::text,'-',''),p_organization_id,t.from_location_id,t.product_id,'transfer_out',-t.quantity,'inventory_transfer',t.id,t.id||':out',p_user_id)
  on conflict(organization_id,idempotency_key) do nothing;
  insert into enterprise_inventory_ledger(id,organization_id,location_id,product_id,movement_type,quantity,reference_type,reference_id,idempotency_key,actor_user_id)
  values('eil_'||replace(gen_random_uuid()::text,'-',''),p_organization_id,t.to_location_id,t.product_id,'transfer_in',t.quantity,'inventory_transfer',t.id,t.id||':in',p_user_id)
  on conflict(organization_id,idempotency_key) do nothing;
  update enterprise_inventory_transfers set status='received',approved_by=coalesce(approved_by,p_user_id),received_at=now() where id=t.id;
  perform record_audit_event('enterprise.inventory.transfer_received','enterprise_inventory_transfer',t.id,p_user_id,'merchant',null,'success',jsonb_build_object('organizationId',p_organization_id,'fromLocationId',t.from_location_id,'toLocationId',t.to_location_id,'quantity',t.quantity));
end $$;
revoke all on function receive_enterprise_inventory_transfer(text,text,text) from public;

-- Prevent enterprise service cases from crossing organization boundaries.
create or replace function validate_enterprise_service_case()
returns trigger language plpgsql as $$
declare v_org text; v_order_user text; v_product_merchant text; v_serial_org text;
begin
  if new.service_location_id is not null then
    select organization_id into v_org from merchant_inventory_locations where id=new.service_location_id;
    if v_org is distinct from new.organization_id then raise exception 'service location organization mismatch'; end if;
  end if;
  if new.order_id is not null then
    select user_id into v_order_user from orders where id=new.order_id;
    if v_order_user is distinct from new.customer_user_id then raise exception 'service case customer/order mismatch'; end if;
  end if;
  if new.product_id is not null then
    select m.id into v_product_merchant from products p join merchants m on m.id=p.merchant_id join enterprise_organizations e on e.merchant_id=m.id where p.id=new.product_id and e.id=new.organization_id;
    if v_product_merchant is null then raise exception 'service case product organization mismatch'; end if;
  end if;
  if new.serial_unit_id is not null then
    select organization_id into v_serial_org from enterprise_serial_units where id=new.serial_unit_id;
    if v_serial_org is distinct from new.organization_id then raise exception 'service case serial organization mismatch'; end if;
  end if;
  return new;
end $$;
drop trigger if exists enterprise_service_case_guard on enterprise_service_cases;
create trigger enterprise_service_case_guard
before insert or update of organization_id,customer_user_id,order_id,product_id,serial_unit_id,service_location_id
on enterprise_service_cases for each row execute function validate_enterprise_service_case();

comment on table enterprise_integrations is 'Enterprise ERP/POS/WMS/carrier/service connector registry. Credentials remain in external secret storage via credential_ref.';
comment on table enterprise_sync_runs is 'Versioned bulk/delta synchronization runs with generation and reconciliation semantics.';
comment on table enterprise_sync_events is 'Idempotent integration event ledger with dead-letter support.';
comment on table enterprise_service_cases is 'After-sales service workflow separated from fulfillment locations and payment/refund custody.';
comment on table enterprise_fulfillment_allocations is 'Auditable order-item to fulfillment-node allocations supporting split shipments.';

-- Service centers are first-class enterprise nodes, but are not automatically eligible to fulfill retail orders.
alter table merchant_inventory_locations drop constraint if exists merchant_inventory_locations_location_type_check;
alter table merchant_inventory_locations add constraint merchant_inventory_locations_location_type_check
  check (location_type in ('store','warehouse','distribution_center','fulfillment_center','pickup_point','office','service_center'));

-- Enterprise administration must be an explicit enterprise role, not merely a merchant login.
create or replace function assert_enterprise_admin_access(p_user_id text,p_organization_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from enterprise_location_staff where organization_id=p_organization_id and user_id=p_user_id and status='active' and role='enterprise_admin') then
    raise exception 'enterprise administrator access denied';
  end if;
end $$;
revoke all on function assert_enterprise_admin_access(text,text) from public;

insert into enterprise_location_staff(id,organization_id,user_id,location_id,role,status)
select 'est_'||replace(gen_random_uuid()::text,'-',''),e.id,ma.user_id,null,'enterprise_admin','active'
from enterprise_organizations e
join merchant_accounts ma on ma.merchant_id=e.merchant_id and ma.status='active'
where not exists(select 1 from enterprise_location_staff s where s.organization_id=e.id and s.user_id=ma.user_id and s.location_id is null and s.role='enterprise_admin')
  and exists(select 1 from enterprise_organizations e2 where e2.id=e.id);
