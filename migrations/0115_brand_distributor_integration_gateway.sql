-- v1.84: Brand & Distributor Integration Gateway.
-- Provider-neutral enterprise integration layer for authorized brands/distributors.
-- No payment custody, tax engine, or escrow behavior is introduced here.

create table if not exists brand_integration_connections (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  organization_id text references enterprise_organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete restrict,
  authorization_id text references merchant_brand_authorizations(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 2 and 160),
  connector_type text not null check (connector_type in ('rest_json','csv','xml','erp_oms_wms','manual_feed')),
  environment text not null default 'sandbox' check (environment in ('sandbox','production')),
  base_url text check (base_url is null or char_length(base_url) between 8 and 2000),
  auth_type text not null default 'none' check (auth_type in ('none','bearer','api_key','basic','hmac')),
  credentials_encrypted text,
  scopes text[] not null default '{}',
  capabilities text[] not null default '{}',
  field_mapping jsonb not null default '{}'::jsonb,
  sync_mode text not null default 'delta' check (sync_mode in ('delta','snapshot','manual')),
  stale_after_seconds integer not null default 900 check (stale_after_seconds between 60 and 604800),
  status text not null default 'active' check (status in ('active','paused','error','revoked')),
  webhook_enabled boolean not null default false,
  webhook_secret_encrypted text,
  external_account_ref text,
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  last_sync_status text check (last_sync_status in ('success','partial','failed')),
  last_sync_count integer not null default 0 check (last_sync_count >= 0),
  last_inventory_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(merchant_id,name)
);
create index if not exists brand_integration_connections_brand_idx on brand_integration_connections(brand_id,status,environment);
create index if not exists brand_integration_connections_merchant_idx on brand_integration_connections(merchant_id,status);

create or replace function validate_brand_integration_connection()
returns trigger language plpgsql as $$
declare v_auth record; v_org_merchant text;
begin
  if new.organization_id is not null then
    select merchant_id into v_org_merchant from enterprise_organizations where id=new.organization_id and status='active';
    if v_org_merchant is distinct from new.merchant_id then raise exception 'integration organization does not belong to merchant'; end if;
  end if;
  select id,status,expires_at,merchant_id,brand_id,relationship into v_auth
    from merchant_brand_authorizations
   where id=coalesce(new.authorization_id,'')
     and merchant_id=new.merchant_id and brand_id=new.brand_id;
  if new.authorization_id is not null then
    if not found or v_auth.status <> 'verified' or (v_auth.expires_at is not null and v_auth.expires_at <= now()) then
      raise exception 'brand authorization is missing, inactive, or expired';
    end if;
  else
    if not exists(
      select 1 from merchant_brand_authorizations a
       where a.merchant_id=new.merchant_id and a.brand_id=new.brand_id and a.status='verified'
         and (a.expires_at is null or a.expires_at > now())
    ) then raise exception 'active verified brand authorization required'; end if;
  end if;
  if new.connector_type in ('rest_json','xml','erp_oms_wms') and new.base_url is null then raise exception 'base_url required for network connector'; end if;
  new.updated_at=now();
  return new;
end $$;

drop trigger if exists brand_integration_connection_guard on brand_integration_connections;
create trigger brand_integration_connection_guard
before insert or update of merchant_id,organization_id,brand_id,authorization_id,connector_type,base_url,status on brand_integration_connections
for each row execute function validate_brand_integration_connection();

create table if not exists brand_integration_sync_runs (
  id text primary key,
  connection_id text not null references brand_integration_connections(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  source text not null check (source in ('manual','scheduled','webhook','reconcile')),
  status text not null default 'running' check (status in ('running','success','partial','failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  received_count integer not null default 0 check (received_count>=0),
  accepted_count integer not null default 0 check (accepted_count>=0),
  rejected_count integer not null default 0 check (rejected_count>=0),
  created_count integer not null default 0 check (created_count>=0),
  updated_count integer not null default 0 check (updated_count>=0),
  stale_rejected_count integer not null default 0 check (stale_rejected_count>=0),
  error_message text
);
create index if not exists brand_integration_sync_runs_connection_idx on brand_integration_sync_runs(connection_id,started_at desc);

create table if not exists brand_integration_product_map (
  id text primary key,
  connection_id text not null references brand_integration_connections(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  external_product_id text not null,
  external_sku text,
  product_id text references products(id) on delete set null,
  payload_hash text not null,
  external_version bigint,
  last_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active','stale','quarantined','disabled')),
  unique(connection_id,external_product_id)
);
create index if not exists brand_integration_product_map_product_idx on brand_integration_product_map(product_id);
create index if not exists brand_integration_product_map_stale_idx on brand_integration_product_map(connection_id,status,last_seen_at);

create table if not exists brand_integration_reconciliation (
  id text primary key,
  connection_id text not null references brand_integration_connections(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  entity_type text not null check (entity_type in ('product','price','inventory','order','shipment','return','warranty')),
  entity_key text not null,
  discrepancy_type text not null check (discrepancy_type in ('missing_remote','missing_local','version_conflict','stale','quantity_mismatch','price_mismatch','status_mismatch','mapping_error')),
  local_value jsonb,
  remote_value jsonb,
  status text not null default 'open' check (status in ('open','acknowledged','resolved','ignored')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(connection_id,entity_type,entity_key,discrepancy_type)
);
create index if not exists brand_integration_reconciliation_open_idx on brand_integration_reconciliation(connection_id,status,detected_at desc);

create table if not exists brand_integration_webhook_events (
  id text primary key,
  connection_id text not null references brand_integration_connections(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  external_event_id text,
  event_type text not null,
  payload_hash text not null,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received','processing','processed','failed','dead')),
  attempts integer not null default 0 check (attempts>=0),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  next_attempt_at timestamptz,
  last_error text,
  unique(connection_id,external_event_id)
);
create index if not exists brand_integration_webhook_retry_idx on brand_integration_webhook_events(status,next_attempt_at,received_at);

create table if not exists brand_integration_order_outbox (
  id text primary key,
  connection_id text not null references brand_integration_connections(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  order_id text not null references orders(id) on delete cascade,
  event_type text not null check (event_type in ('order.created','order.status_changed','order.cancelled','order.return_requested')),
  idempotency_key text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','retry','dead')),
  attempts integer not null default 0 check (attempts>=0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connection_id,idempotency_key)
);
create index if not exists brand_integration_order_outbox_ready_idx on brand_integration_order_outbox(status,available_at,created_at);

create or replace function brand_integration_enqueue_order_event(p_order_id text,p_event_type text,p_payload jsonb default '{}'::jsonb)
returns integer language plpgsql as $$
declare v_count integer:=0; v_order record; v_conn record; v_key text;
begin
  if p_event_type not in ('order.created','order.status_changed','order.cancelled','order.return_requested') then raise exception 'unsupported brand integration order event'; end if;
  select id,merchant_id into v_order from orders where id=p_order_id;
  if not found then raise exception 'order not found'; end if;
  for v_conn in select id,merchant_id from brand_integration_connections where merchant_id=v_order.merchant_id and status='active' and 'orders:write'=any(scopes) loop
    v_key:=p_order_id||':'||p_event_type||':'||coalesce(p_payload->>'transitionKey',p_order_id);
    insert into brand_integration_order_outbox(id,connection_id,merchant_id,order_id,event_type,idempotency_key,payload)
    values('bioo_'||replace(gen_random_uuid()::text,'-',''),v_conn.id,v_conn.merchant_id,p_order_id,p_event_type,v_key,p_payload)
    on conflict(connection_id,idempotency_key) do nothing;
    if found then v_count:=v_count+1; end if;
  end loop;
  return v_count;
end $$;

create or replace function brand_integration_order_trigger()
returns trigger language plpgsql as $$
declare v_payload jsonb; v_event text;
begin
  if TG_OP='INSERT' then
    v_event:='order.created';
    v_payload:=jsonb_build_object('orderId',new.id,'merchantId',new.merchant_id,'status',new.status,'grandTotal',new.grand_total,'currency','GHS','createdAt',new.created_at,'transitionKey',new.id||':created');
  elsif TG_OP='UPDATE' and new.status is distinct from old.status then
    v_event:='order.status_changed';
    v_payload:=jsonb_build_object('orderId',new.id,'merchantId',new.merchant_id,'fromStatus',old.status,'status',new.status,'grandTotal',new.grand_total,'currency','GHS','updatedAt',new.updated_at,'transitionKey',new.id||':'||old.status||':'||new.status);
  else return new; end if;
  perform brand_integration_enqueue_order_event(new.id,v_event,v_payload);
  return new;
end $$;

drop trigger if exists brand_integration_order_outbox_trigger on orders;
create trigger brand_integration_order_outbox_trigger
after insert or update of status on orders
for each row execute function brand_integration_order_trigger();

comment on table brand_integration_connections is 'Authorized brand/distributor integration gateway connections. Credentials are encrypted server-side and scopes are explicit.';
comment on table brand_integration_product_map is 'External-to-canonical product identity mapping with freshness and version controls.';
comment on table brand_integration_reconciliation is 'Durable discrepancy ledger for catalogue, price, inventory, order, shipment, return and warranty reconciliation.';
comment on table brand_integration_order_outbox is 'Asynchronous order delivery queue; external ERP/API failures never block marketplace checkout.';

-- Authorization revocation must immediately disable connected brand integrations.
create or replace function revoke_brand_integrations_on_authorization_change()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status or new.expires_at is distinct from old.expires_at then
    if new.status <> 'verified' or (new.expires_at is not null and new.expires_at <= now()) then
      update brand_integration_connections
         set status='revoked',updated_at=now()
       where authorization_id=new.id and status in ('active','error','paused');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists merchant_brand_authorization_integration_guard on merchant_brand_authorizations;
create trigger merchant_brand_authorization_integration_guard
after update of status,expires_at on merchant_brand_authorizations
for each row execute function revoke_brand_integrations_on_authorization_change();
