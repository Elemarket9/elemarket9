-- Enterprise high-scale integration plane.
-- Catalogue ingestion is staged/reconciled, webhooks are durable and idempotent,
-- and enterprise orders use an asynchronous outbox instead of synchronous PSP/ERP coupling.

alter table enterprise_catalog_connections
  add column if not exists page_size integer not null default 250 check (page_size between 1 and 1000),
  add column if not exists cursor_param text not null default 'cursor' check (char_length(cursor_param) between 1 and 80),
  add column if not exists cursor_path text,
  add column if not exists next_cursor text,
  add column if not exists inventory_stale_after_seconds integer not null default 900 check (inventory_stale_after_seconds between 60 and 604800),
  add column if not exists last_inventory_sync_at timestamptz,
  add column if not exists last_connection_test_at timestamptz,
  add column if not exists last_connection_test_status text check (last_connection_test_status in ('success','failed')),
  add column if not exists last_connection_test_error text,
  add column if not exists order_endpoint_url text,
  add column if not exists order_webhook_enabled boolean not null default false,
  add column if not exists order_webhook_secret_encrypted text;

alter table enterprise_catalog_items
  add column if not exists sync_generation bigint,
  add column if not exists validation_status text not null default 'valid' check (validation_status in ('valid','invalid')),
  add column if not exists validation_error text,
  add column if not exists external_updated_at timestamptz;
create index if not exists enterprise_catalog_items_generation_idx
  on enterprise_catalog_items(connection_id,sync_generation);

alter table enterprise_catalog_sync_runs
  add column if not exists generation bigint,
  add column if not exists cursor_pages integer not null default 0 check (cursor_pages >= 0);
create unique index if not exists enterprise_catalog_sync_generation_uq
  on enterprise_catalog_sync_runs(connection_id,generation)
  where generation is not null;

create sequence if not exists enterprise_catalog_generation_seq;

create table if not exists enterprise_webhook_events (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  connection_id text references enterprise_catalog_connections(id) on delete set null,
  external_event_id text,
  event_type text not null check (char_length(trim(event_type)) between 1 and 120),
  payload_hash text not null,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received','processing','processed','failed','ignored')),
  attempts integer not null default 0 check (attempts >= 0),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  next_attempt_at timestamptz,
  last_error text
);
create unique index if not exists enterprise_webhook_events_external_uq
  on enterprise_webhook_events(merchant_id,external_event_id)
  where external_event_id is not null;
create index if not exists enterprise_webhook_events_retry_idx
  on enterprise_webhook_events(status,next_attempt_at,received_at);

create table if not exists enterprise_order_outbox (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  order_id text not null references orders(id) on delete cascade,
  event_type text not null check (event_type in ('order.created','order.cancelled','order.status_changed','order.return_requested')),
  idempotency_key text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','retry','dead')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(merchant_id,idempotency_key)
);
create index if not exists enterprise_order_outbox_ready_idx
  on enterprise_order_outbox(status,available_at,created_at);
create index if not exists enterprise_order_outbox_merchant_idx
  on enterprise_order_outbox(merchant_id,created_at desc);

create or replace function enterprise_enqueue_order_event(
  p_order_id text,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb
) returns text language plpgsql as $$
declare
  v_order record;
  v_id text := 'eoo_'||replace(gen_random_uuid()::text,'-','');
  v_key text;
begin
  if p_event_type not in ('order.created','order.cancelled','order.status_changed','order.return_requested') then
    raise exception 'unsupported enterprise order event';
  end if;
  select o.id,o.merchant_id,m.catalog_source,m.settlement_model
    into v_order
    from orders o join merchants m on m.id=o.merchant_id
   where o.id=p_order_id;
  if not found then raise exception 'order not found'; end if;
  if v_order.catalog_source <> 'enterprise_api' or v_order.settlement_model <> 'enterprise_direct' then
    return null;
  end if;
  v_key := p_order_id||':'||p_event_type||':'||coalesce(p_payload->>'transitionKey',p_order_id);
  insert into enterprise_order_outbox(id,merchant_id,order_id,event_type,idempotency_key,payload)
  values(v_id,v_order.merchant_id,p_order_id,p_event_type,p_payload)
  on conflict(merchant_id,idempotency_key) do nothing;
  return v_id;
end;
$$;

comment on table enterprise_webhook_events is 'Durable, idempotent enterprise webhook ledger. Provider payloads are retained for replay and operational diagnosis.';
comment on table enterprise_order_outbox is 'Asynchronous enterprise order delivery queue. External ERP/API availability never blocks the marketplace order transaction.';

create or replace function enterprise_order_outbox_trigger()
returns trigger language plpgsql as $$
declare
  v_payload jsonb;
  v_event text;
begin
  if TG_OP='INSERT' then
    v_event := 'order.created';
    v_payload := jsonb_build_object(
      'orderId',new.id,'merchantId',new.merchant_id,'status',new.status,
      'grandTotal',new.grand_total,'productTotal',new.product_total,
      'deliveryTotal',new.delivery_total,'currency','GHS','address',new.address,
      'createdAt',new.created_at,'transitionKey',new.id||':created',
      'items',(select coalesce(jsonb_agg(jsonb_build_object('productId',oi.product_id,'quantity',oi.quantity,'unitPrice',oi.unit_price,'productTotal',oi.product_total) order by oi.id),'[]'::jsonb) from order_items oi where oi.order_id=new.id)
    );
  elsif TG_OP='UPDATE' and new.status is distinct from old.status then
    v_event := 'order.status_changed';
    v_payload := jsonb_build_object(
      'orderId',new.id,'merchantId',new.merchant_id,'fromStatus',old.status,
      'status',new.status,'grandTotal',new.grand_total,'currency','GHS',
      'updatedAt',new.updated_at,'transitionKey',new.id||':'||old.status||':'||new.status
    );
  else
    return new;
  end if;
  perform enterprise_enqueue_order_event(new.id,v_event,v_payload);
  return new;
end;
$$;

drop trigger if exists enterprise_order_outbox_on_order on orders;
create trigger enterprise_order_outbox_on_order
after insert or update of status on orders
for each row execute function enterprise_order_outbox_trigger();

create or replace function enforce_enterprise_inventory_freshness()
returns trigger language plpgsql as $$
declare
  v_catalog text;
  v_last_sync timestamptz;
  v_max_age integer;
begin
  select catalog_source into v_catalog from merchants where id=new.merchant_id;
  if v_catalog <> 'enterprise_api' then return new; end if;
  select last_inventory_sync_at,inventory_stale_after_seconds
    into v_last_sync,v_max_age
    from enterprise_catalog_connections
   where merchant_id=new.merchant_id and status='active';
  if v_last_sync is null or v_last_sync < now() - make_interval(secs => coalesce(v_max_age,900)) then
    raise exception 'enterprise inventory is stale; order creation is temporarily unavailable until inventory synchronizes';
  end if;
  return new;
end;
$$;

drop trigger if exists enterprise_inventory_freshness_guard on orders;
create trigger enterprise_inventory_freshness_guard
before insert on orders
for each row execute function enforce_enterprise_inventory_freshness();

comment on function enforce_enterprise_inventory_freshness() is 'Enterprise orders require a recent successful inventory synchronization. The guard executes before order commit so stale inventory rolls back the entire checkout transaction.';
