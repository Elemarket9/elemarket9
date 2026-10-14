-- v1.78: enterprise marketplace / brand-partner readiness.
-- Adds durable product identity, brand authorization enforcement, inventory locations,
-- partial fulfillment/shipment primitives, partner API credentials/scopes, and
-- reconciliation/audit records. ELEMARKET remains non-custodial.

-- -----------------------------------------------------------------------------
-- 1. Canonical product identifiers
-- -----------------------------------------------------------------------------
create table if not exists product_identifiers (
  id text primary key,
  product_id text not null references products(id) on delete cascade,
  identifier_type text not null check (identifier_type in ('gtin12','gtin13','gtin14','upc','ean','mpn','imei','serial')),
  identifier_value text not null check (char_length(trim(identifier_value)) between 3 and 64),
  normalized_value text generated always as (lower(regexp_replace(trim(identifier_value),'[^a-zA-Z0-9]','','g'))) stored,
  source text not null default 'merchant' check (source in ('merchant','enterprise_feed','brand','admin')),
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id,identifier_type,normalized_value)
);
create unique index if not exists product_identifiers_global_uq
  on product_identifiers(identifier_type,normalized_value)
  where identifier_type in ('gtin12','gtin13','gtin14','upc','ean');
create index if not exists product_identifiers_product_idx on product_identifiers(product_id,identifier_type);

-- -----------------------------------------------------------------------------
-- 2. Brand authorization: a product cannot publish under a brand without an
--    active authorization relationship (except an explicitly unbranded listing).
-- -----------------------------------------------------------------------------
create or replace function enforce_product_brand_authorization()
returns trigger language plpgsql as $$
declare
  v_brand_status text;
  v_auth boolean;
begin
  if new.brand_id is null then return new; end if;
  select status into v_brand_status from brands where id=new.brand_id;
  if v_brand_status is distinct from 'active' then raise exception 'brand is not active'; end if;
  select exists(
    select 1 from merchant_brand_authorizations mba
    where mba.merchant_id=new.merchant_id
      and mba.brand_id=new.brand_id
      and mba.status='verified'
      and (mba.expires_at is null or mba.expires_at > now())
  ) into v_auth;
  if not v_auth then raise exception 'merchant is not authorized to list this brand'; end if;
  return new;
end;
$$;

drop trigger if exists product_brand_authorization_guard on products;
create trigger product_brand_authorization_guard
before insert or update of merchant_id,brand_id on products
for each row execute function enforce_product_brand_authorization();

-- -----------------------------------------------------------------------------
-- 3. Inventory locations / reservations
-- -----------------------------------------------------------------------------
create table if not exists merchant_inventory_locations (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  external_location_id text,
  name text not null check (char_length(trim(name)) between 2 and 160),
  address text not null check (char_length(trim(address)) between 4 and 400),
  city text not null,
  country_code char(2) not null default 'GH',
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(merchant_id,external_location_id)
);
create index if not exists inventory_locations_merchant_idx on merchant_inventory_locations(merchant_id,status);

create table if not exists product_location_inventory (
  id text primary key,
  product_id text not null references products(id) on delete cascade,
  location_id text not null references merchant_inventory_locations(id) on delete cascade,
  available integer not null default 0 check (available >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  safety_stock integer not null default 0 check (safety_stock >= 0),
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  unique(product_id,location_id)
);
create index if not exists product_location_inventory_product_idx on product_location_inventory(product_id,updated_at desc);

create or replace function validate_product_location_inventory_ownership()
returns trigger language plpgsql as $$
declare v_pm text; v_lm text;
begin
  select merchant_id into v_pm from products where id=new.product_id;
  select merchant_id into v_lm from merchant_inventory_locations where id=new.location_id;
  if v_pm is null or v_lm is null or v_pm is distinct from v_lm then raise exception 'inventory location does not belong to product merchant'; end if;
  if new.available + new.reserved < new.safety_stock then raise exception 'inventory is below configured safety stock'; end if;
  new.version=coalesce(new.version,1)+1;
  new.updated_at=now();
  return new;
end;
$$;

drop trigger if exists product_location_inventory_ownership_guard on product_location_inventory;
create trigger product_location_inventory_ownership_guard
before insert or update of product_id,location_id,available,reserved,safety_stock on product_location_inventory
for each row execute function validate_product_location_inventory_ownership();

-- -----------------------------------------------------------------------------
-- 4. Partial fulfillment and shipment graph
-- -----------------------------------------------------------------------------
create table if not exists shipments (
  id text primary key,
  order_id text not null references orders(id) on delete restrict,
  merchant_id text not null references merchants(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','packed','shipped','in_transit','out_for_delivery','delivered','failed','cancelled','returned')),
  carrier text,
  tracking_number text,
  tracking_url text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  estimated_delivery_start timestamptz,
  estimated_delivery_end timestamptz,
  external_shipment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(merchant_id,external_shipment_id)
);
create index if not exists shipments_order_idx on shipments(order_id,created_at);
create index if not exists shipments_tracking_idx on shipments(carrier,tracking_number) where tracking_number is not null;

create table if not exists shipment_items (
  id text primary key,
  shipment_id text not null references shipments(id) on delete cascade,
  order_item_id bigint not null references order_items(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  unique(shipment_id,order_item_id)
);
create index if not exists shipment_items_order_item_idx on shipment_items(order_item_id);

create or replace function validate_shipment_graph()
returns trigger language plpgsql as $$
declare v_order text; v_merchant text; v_item_order text; v_item_merchant text; v_shipped integer; v_ordered integer;
begin
  select order_id,merchant_id into v_order,v_merchant from shipments where id=new.shipment_id;
  select order_id into v_item_order from order_items where id=new.order_item_id;
  if v_order is null or v_item_order is null or v_order is distinct from v_item_order then raise exception 'shipment item does not belong to shipment order'; end if;
  if v_merchant is null or not exists(select 1 from orders o where o.id=v_order and o.merchant_id=v_merchant) then raise exception 'shipment merchant/order mismatch'; end if;
  select coalesce(sum(si.quantity),0)::int into v_shipped from shipment_items si join shipments s on s.id=si.shipment_id where si.order_item_id=new.order_item_id and s.status <> 'cancelled' and si.id<>coalesce(new.id,'');
  select quantity into v_ordered from order_items where id=new.order_item_id;
  if v_shipped + new.quantity > v_ordered then raise exception 'shipment quantity exceeds ordered quantity'; end if;
  return new;
end;
$$;

drop trigger if exists shipment_item_graph_guard on shipment_items;
create trigger shipment_item_graph_guard
before insert or update of shipment_id,order_item_id,quantity on shipment_items
for each row execute function validate_shipment_graph();

create table if not exists shipment_events (
  id text primary key,
  shipment_id text not null references shipments(id) on delete cascade,
  event_type text not null check (event_type in ('label_created','picked_up','in_transit','out_for_delivery','delivered','delivery_failed','returned_to_sender')),
  event_at timestamptz not null,
  location text,
  carrier_event_id text,
  payload_hash text,
  created_at timestamptz not null default now(),
  unique(shipment_id,carrier_event_id)
);
create index if not exists shipment_events_shipment_idx on shipment_events(shipment_id,event_at desc);

-- -----------------------------------------------------------------------------
-- 5. Returns: explicit replacement/exchange outcomes without custody.
-- -----------------------------------------------------------------------------
alter table return_requests add column if not exists resolution_type text not null default 'refund' check (resolution_type in ('refund','replacement','exchange'));
alter table return_requests add column if not exists replacement_order_id text references orders(id) on delete restrict;
alter table return_requests add column if not exists received_at timestamptz;
alter table return_requests add column if not exists closed_at timestamptz;
create index if not exists return_requests_replacement_idx on return_requests(replacement_order_id) where replacement_order_id is not null;

-- -----------------------------------------------------------------------------
-- 6. Enterprise partner API clients / scoped credentials
-- -----------------------------------------------------------------------------
create table if not exists enterprise_api_clients (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  client_name text not null check (char_length(trim(client_name)) between 2 and 160),
  client_key_id text not null unique,
  client_secret_hash text not null,
  status text not null default 'active' check (status in ('active','suspended','revoked')),
  scopes text[] not null default '{}',
  rate_limit_per_minute integer not null default 600 check (rate_limit_per_minute between 10 and 100000),
  last_used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists enterprise_api_clients_merchant_idx on enterprise_api_clients(merchant_id,status);

create table if not exists enterprise_api_audit (
  id text primary key,
  client_id text not null references enterprise_api_clients(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  request_id text not null,
  method text not null,
  route text not null,
  scope text,
  response_status integer,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  payload_hash text,
  created_at timestamptz not null default now()
);
create index if not exists enterprise_api_audit_client_idx on enterprise_api_audit(client_id,created_at desc);
create index if not exists enterprise_api_audit_request_idx on enterprise_api_audit(request_id);

create or replace function assert_enterprise_api_scope(p_client_id text,p_merchant_id text,p_required_scope text)
returns void language plpgsql as $$
declare v record;
begin
  select * into v from enterprise_api_clients where id=p_client_id and merchant_id=p_merchant_id and status='active' for update;
  if not found then raise exception 'enterprise API client not authorized'; end if;
  if v.expires_at is not null and v.expires_at <= now() then raise exception 'enterprise API client expired'; end if;
  if not (p_required_scope = any(v.scopes)) then raise exception 'enterprise API scope denied'; end if;
  update enterprise_api_clients set last_used_at=now(),updated_at=now() where id=v.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Reconciliation ledger for partner/order/payment/fulfillment drift.
-- -----------------------------------------------------------------------------
create table if not exists marketplace_reconciliation_cases (
  id text primary key,
  merchant_id text references merchants(id) on delete cascade,
  order_id text references orders(id) on delete set null,
  external_reference text,
  case_type text not null check (case_type in ('payment','refund','inventory','shipment','catalog','settlement')),
  severity text not null default 'warning' check (severity in ('info','warning','high','critical')),
  status text not null default 'open' check (status in ('open','investigating','resolved','ignored')),
  expected_hash text,
  observed_hash text,
  details jsonb not null default '{}'::jsonb,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reconciliation_open_idx on marketplace_reconciliation_cases(status,severity,created_at desc) where status in ('open','investigating');
create index if not exists reconciliation_order_idx on marketplace_reconciliation_cases(order_id,created_at desc);

-- Enterprise APIs should never receive secrets, payment credentials or raw customer
-- authentication material. Payloads must be explicitly constructed by route code.
comment on table product_identifiers is 'Canonical product identity layer for GTIN/UPC/EAN/MPN/IMEI/serial readiness. Global retail identifiers are unique across the marketplace.';
comment on table shipments is 'Partial-fulfillment primitive. One order can contain multiple packages/shipments; payment remains separate.';
comment on table enterprise_api_clients is 'Merchant-scoped enterprise API credentials with hashed secrets and explicit scopes. Raw secrets are never stored.';
comment on table marketplace_reconciliation_cases is 'Operational reconciliation queue for partner/payment/inventory/shipment/catalog drift.';
