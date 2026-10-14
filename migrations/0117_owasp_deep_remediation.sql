-- v1.86: OWASP/API Security deep remediation for brand/distributor integrations.
-- Preserves ELEMARKET's non-custodial marketplace boundary: no escrow, custody, tax engine,
-- or provider settlement logic is introduced.

-- -----------------------------------------------------------------------------
-- 1. Credential rotation: exactly one active version per connection.
-- -----------------------------------------------------------------------------
with ranked as (
  select id, row_number() over (partition by connection_id order by activated_at desc, id desc) rn
  from brand_integration_credentials where status='active'
)
update brand_integration_credentials c
set status='retired', retired_at=coalesce(retired_at,now())
from ranked r where c.id=r.id and r.rn>1;
create unique index if not exists brand_integration_credentials_one_active_uq
  on brand_integration_credentials(connection_id) where status='active';

-- -----------------------------------------------------------------------------
-- 2. Webhook processing leases and replay metadata.
-- -----------------------------------------------------------------------------
alter table brand_integration_webhook_events add column if not exists locked_at timestamptz;
alter table brand_integration_webhook_events add column if not exists locked_token text;
alter table brand_integration_webhook_events add column if not exists signature_timestamp timestamptz;
alter table brand_integration_order_outbox add column if not exists locked_at timestamptz;
alter table brand_integration_order_outbox add column if not exists locked_token text;
create index if not exists brand_integration_order_locked_idx on brand_integration_order_outbox(status,locked_at) where status='processing';
create index if not exists brand_integration_webhook_locked_idx
  on brand_integration_webhook_events(status,locked_at);

-- Event types are an explicit security boundary. Existing rows are preserved.
alter table brand_integration_webhook_events
  drop constraint if exists brand_integration_webhook_event_type_check;
alter table brand_integration_webhook_events
  add constraint brand_integration_webhook_event_type_check
  check(event_type in ('catalog.changed','inventory.changed','price.changed','order.acknowledged',
                       'order.status_changed','fulfillment.updated','return.updated','warranty.updated')) not valid;

-- -----------------------------------------------------------------------------
-- 3. Integration payload/resource ceilings at the DB boundary.
-- -----------------------------------------------------------------------------
alter table brand_integration_connections
  add constraint brand_integration_field_mapping_size_check
  check(pg_column_size(field_mapping) <= 32768) not valid;
alter table brand_integration_connections
  add constraint brand_integration_scopes_size_check
  check(coalesce(array_length(scopes,1),0) between 1 and 16) not valid;
alter table brand_integration_connections
  add constraint brand_integration_capabilities_size_check
  check(coalesce(array_length(capabilities,1),0) <= 64) not valid;
alter table brand_integration_webhook_events
  add constraint brand_integration_webhook_payload_size_check
  check(pg_column_size(payload) <= 2 * 1024 * 1024) not valid;
alter table brand_integration_webhook_events
  add constraint brand_integration_webhook_event_identity_size_check
  check(char_length(event_identity) between 1 and 256) not valid;

-- -----------------------------------------------------------------------------
-- 4. Stronger offer integrity and freshness.
-- -----------------------------------------------------------------------------
alter table brand_integration_offers
  add constraint brand_integration_offer_price_cap_check
  check(price > 0 and price <= 100000000) not valid;
alter table brand_integration_offers
  add constraint brand_integration_offer_stock_cap_check
  check(available between 0 and 1000000) not valid;
create or replace function validate_brand_integration_offer_ownership()
returns trigger language plpgsql as $$
begin
  if not exists(select 1 from products p where p.id=new.product_id and p.merchant_id=new.merchant_id) then
    raise exception 'integration offer merchant/product mismatch';
  end if;
  return new;
end $$;
drop trigger if exists brand_integration_offer_ownership_guard on brand_integration_offers;
create trigger brand_integration_offer_ownership_guard
before insert or update of merchant_id,product_id on brand_integration_offers
for each row execute function validate_brand_integration_offer_ownership();

-- No stale integration offer may be presented as an active source of availability.
create index if not exists brand_integration_offers_fresh_active_idx
  on brand_integration_offers(product_id,status,last_seen_at desc)
  where status='active';

-- -----------------------------------------------------------------------------
-- 5. Snapshot completeness and authorization state.
-- -----------------------------------------------------------------------------
alter table brand_integration_sync_runs add column if not exists authoritative_snapshot boolean not null default false;
alter table brand_integration_sync_runs add column if not exists error_code text;
create index if not exists brand_integration_sync_runs_running_idx
  on brand_integration_sync_runs(connection_id,status,started_at)
  where status='running';

-- -----------------------------------------------------------------------------
-- 6. Queue recovery: processing records can never remain leased forever.
-- -----------------------------------------------------------------------------
create or replace function recover_brand_integration_processing_claims(p_timeout_seconds integer default 600)
returns integer language plpgsql as $$
declare v_count integer;
begin
  update brand_integration_webhook_events
     set status=case when attempts>=10 then 'dead' else 'failed' end,
         next_attempt_at=case when attempts>=10 then null else now() end,
         locked_at=null,locked_token=null,
         last_error=coalesce(last_error,'worker lease expired')
   where status='processing' and locked_at < now() - make_interval(secs=>greatest(p_timeout_seconds,60));
  get diagnostics v_count = row_count;
  update brand_integration_order_outbox
     set status=case when attempts>=10 then 'dead' else 'retry' end,
         available_at=case when attempts>=10 then available_at else now() end,
         locked_at=null,
         last_error=coalesce(last_error,'worker lease expired'),updated_at=now()
   where status='processing' and locked_at < now() - make_interval(secs=>greatest(p_timeout_seconds,60));
  return v_count;
end $$;
revoke all on function recover_brand_integration_processing_claims(integer) from public;
grant execute on function recover_brand_integration_processing_claims(integer) to current_user;

-- -----------------------------------------------------------------------------
-- 7. Runtime authorization helper for queued/mutating operations.
-- -----------------------------------------------------------------------------
create or replace function assert_brand_integration_authorized(p_connection_id text)
returns boolean language plpgsql stable as $$
begin
  return exists(
    select 1
    from brand_integration_connections c
    join merchant_brand_authorizations a
      on a.merchant_id=c.merchant_id and a.brand_id=c.brand_id
     and (c.authorization_id is null or a.id=c.authorization_id)
   where c.id=p_connection_id and c.status='active'
     and a.status='verified' and (a.expires_at is null or a.expires_at>now())
  );
end $$;
revoke all on function assert_brand_integration_authorized(text) from public;
grant execute on function assert_brand_integration_authorized(text) to current_user;

-- -----------------------------------------------------------------------------
-- 8. Stronger record validation / stale-version semantics / authoritative fields.
-- -----------------------------------------------------------------------------
create or replace function apply_brand_integration_record(
  p_connection_id text,p_merchant_id text,p_location_id text,p_record jsonb
) returns table(created boolean,updated boolean,stale_rejected boolean)
language plpgsql as $$
declare
  c record; m record; p_id text; h text; v_ext bigint; is_new boolean;
  v_name text; v_category text; v_price numeric; v_stock integer; v_currency text;
  v_brand text; v_model text; v_subcategory text; v_condition text; v_desc text; v_image text;
  v_sku text; v_gtin text; v_mpn text; v_key text; v_attrs jsonb;
begin
  select c1.* into c from brand_integration_connections c1 where c1.id=p_connection_id and c1.merchant_id=p_merchant_id for update;
  if not found or c.status<>'active' or not assert_brand_integration_authorized(p_connection_id) then raise exception 'integration connection unauthorized'; end if;
  if jsonb_typeof(p_record)<>'object' or pg_column_size(p_record)>65536 then raise exception 'invalid integration record size'; end if;
  if char_length(trim(coalesce(p_record->>'externalProductId',''))) not between 1 and 160 then raise exception 'invalid external product id'; end if;
  v_name=trim(p_record->>'name'); v_category=trim(p_record->>'category');
  begin v_price=(p_record->>'price')::numeric; v_stock=(p_record->>'stock')::integer;
  exception when others then raise exception 'invalid integration numeric values'; end;
  v_currency=upper(coalesce(p_record->>'currency','GHS'));
  if v_name is null or char_length(v_name) not between 2 and 200 or v_category is null or char_length(v_category) not between 1 and 120
     or v_price is null or v_price<=0 or v_price>100000000 or v_stock is null or v_stock<0 or v_stock>1000000 or v_currency<>'GHS'
  then raise exception 'invalid integration record'; end if;
  v_sku=nullif(trim(p_record->>'externalSku'),''); v_brand=nullif(trim(p_record->>'brand'),'');
  v_model=nullif(trim(p_record->>'model'),''); v_subcategory=nullif(trim(p_record->>'subcategory'),'');
  v_condition=nullif(trim(p_record->>'condition'),''); v_desc=coalesce(p_record->>'description','');
  v_image=nullif(trim(p_record->>'imageUrl'),''); v_gtin=nullif(trim(p_record->>'gtin'),''); v_mpn=nullif(trim(p_record->>'mpn'),'');
  if char_length(v_desc)>4000 or char_length(coalesce(v_image,''))>2000 or char_length(coalesce(v_brand,''))>120
     or char_length(coalesce(v_model,''))>160 or char_length(coalesce(v_sku,''))>160 or char_length(coalesce(v_mpn,''))>64 then raise exception 'integration field exceeds limit'; end if;
  if v_image is not null and v_image !~* '^https://[^\\s]+$' then v_image=null; end if;
  if p_record ? 'attributes' then
    if jsonb_typeof(p_record->'attributes')<>'object' or pg_column_size(p_record->'attributes')>65536 then raise exception 'integration attributes exceed limit'; end if;
  end if;
  v_attrs=coalesce(p_record->'attributes','{}'::jsonb);
  v_ext=case when nullif(p_record->>'externalVersion','') is null then null else (p_record->>'externalVersion')::bigint end;
  h=encode(digest(p_record::text,'sha256'),'hex');
  select product_id,external_version into m from brand_integration_product_map where connection_id=p_connection_id and external_product_id=trim(p_record->>'externalProductId') for update;
  if m.external_version is not null and (v_ext is null or v_ext<m.external_version) then return query select false,false,true; return; end if;
  p_id=m.product_id;
  if p_id is null and v_gtin is not null then
    select pi.product_id into p_id from product_identifiers pi where pi.identifier_type in ('gtin12','gtin13','gtin14','upc','ean') and pi.normalized_value=lower(regexp_replace(v_gtin,'[^a-zA-Z0-9]','','g')) limit 1;
  end if;
  if p_id is null and v_mpn is not null then
    select pi.product_id into p_id from product_identifiers pi where pi.identifier_type='mpn' and pi.normalized_value=lower(regexp_replace(v_mpn,'[^a-zA-Z0-9]','','g')) limit 1;
  end if;
  is_new:=p_id is null;
  v_key=coalesce(nullif(lower(regexp_replace(v_gtin,'[^a-zA-Z0-9]','','g')),''),nullif(lower(regexp_replace(coalesce(v_brand,'')||':'||coalesce(v_model,''),'[^a-zA-Z0-9:]','','g')),''),lower(regexp_replace(v_name,'[^a-zA-Z0-9]','','g')));
  if is_new then
    p_id='p_'||replace(gen_random_uuid()::text,'-','');
    insert into products(id,merchant_id,name,category,price,currency,stock,description,image_path,created_at,catalog_source,external_product_id,external_sku,external_updated_at,brand_id,model,subcategory,condition,attributes,canonical_product_key)
    values(p_id,c.merchant_id,v_name,v_category,v_price,'GHS',v_stock,v_desc,v_image,now(),'enterprise_api',trim(p_record->>'externalProductId'),v_sku,now(),c.brand_id,v_model,v_subcategory,v_condition,v_attrs,v_key);
  else
    update products set name=v_name,category=v_category,description=v_desc,image_path=v_image,external_sku=v_sku,external_updated_at=now(),brand_id=c.brand_id,model=v_model,subcategory=v_subcategory,condition=v_condition,attributes=v_attrs,canonical_product_key=coalesce(canonical_product_key,v_key),status='active' where id=p_id and merchant_id=c.merchant_id;
    if not found then raise exception 'canonical product ownership mismatch'; end if;
  end if;
  insert into brand_integration_offers(id,connection_id,merchant_id,product_id,external_product_id,external_sku,price,currency,available,external_version,payload_hash,status,last_seen_at,updated_at)
  values('bio_'||replace(gen_random_uuid()::text,'-',''),p_connection_id,c.merchant_id,p_id,trim(p_record->>'externalProductId'),v_sku,v_price,'GHS',v_stock,v_ext,h,'active',now(),now())
  on conflict(connection_id,external_product_id) do update set product_id=excluded.product_id,external_sku=excluded.external_sku,price=excluded.price,available=excluded.available,external_version=excluded.external_version,payload_hash=excluded.payload_hash,status='active',last_seen_at=now(),updated_at=now();
  if p_location_id is not null then
    insert into product_location_inventory(id,product_id,location_id,available,reserved,safety_stock,version,updated_at)
    values('pli_'||replace(gen_random_uuid()::text,'-',''),p_id,p_location_id,v_stock,0,0,1,now())
    on conflict(product_id,location_id) do update set available=excluded.available,version=product_location_inventory.version+1,updated_at=now();
    update products set stock=(select coalesce(sum(greatest(available-reserved-safety_stock,0)),0) from product_location_inventory where product_id=p_id) where id=p_id;
  else update products set price=v_price,stock=v_stock where id=p_id; end if;
  insert into brand_integration_product_map(id,connection_id,merchant_id,external_product_id,external_sku,product_id,payload_hash,external_version,last_seen_at,last_synced_at,status)
  values('bigpm_'||replace(gen_random_uuid()::text,'-',''),p_connection_id,c.merchant_id,trim(p_record->>'externalProductId'),v_sku,p_id,h,v_ext,now(),now(),'active')
  on conflict(connection_id,external_product_id) do update set external_sku=excluded.external_sku,product_id=excluded.product_id,payload_hash=excluded.payload_hash,external_version=excluded.external_version,last_seen_at=now(),last_synced_at=now(),status='active';
  if v_gtin is not null then
    insert into product_identifiers(id,product_id,identifier_type,identifier_value,source,verified)
    values('bigi_'||replace(gen_random_uuid()::text,'-',''),p_id,case when length(regexp_replace(v_gtin,'[^0-9]','','g'))=12 then 'gtin12' when length(regexp_replace(v_gtin,'[^0-9]','','g'))=13 then 'gtin13' when length(regexp_replace(v_gtin,'[^0-9]','','g'))=14 then 'gtin14' else 'ean' end,v_gtin,'enterprise_feed',false)
    on conflict(product_id,identifier_type,normalized_value) do update set identifier_value=excluded.identifier_value,updated_at=now();
  end if;
  if v_mpn is not null then
    insert into product_identifiers(id,product_id,identifier_type,identifier_value,source,verified)
    values('bigi_'||replace(gen_random_uuid()::text,'-',''),p_id,'mpn',v_mpn,'enterprise_feed',false)
    on conflict(product_id,identifier_type,normalized_value) do update set identifier_value=excluded.identifier_value,updated_at=now();
  end if;
  return query select is_new,not is_new,false;
end $$;
revoke all on function apply_brand_integration_record(text,text,text,jsonb) from public;
grant execute on function apply_brand_integration_record(text,text,text,jsonb) to current_user;

-- -----------------------------------------------------------------------------
-- 9. Keep queued order events scoped to an authorized connection at mutation time.
-- -----------------------------------------------------------------------------
create or replace function brand_integration_enqueue_order_event(p_order_id text,p_event_type text,p_payload jsonb default '{}'::jsonb)
returns integer language plpgsql as $$
declare v_count integer:=0; v_order record; v_conn record; v_key text;
begin
  if p_event_type not in ('order.created','order.status_changed','order.cancelled','order.return_requested') then raise exception 'unsupported brand integration order event'; end if;
  select id,merchant_id into v_order from orders where id=p_order_id;
  if not found then raise exception 'order not found'; end if;
  for v_conn in select c.id,c.merchant_id from brand_integration_connections c where c.merchant_id=v_order.merchant_id and c.status='active' and 'orders:write'=any(c.scopes) and assert_brand_integration_authorized(c.id) loop
    v_key:=p_order_id||':'||p_event_type||':'||coalesce(p_payload->>'transitionKey',p_order_id);
    insert into brand_integration_order_outbox(id,connection_id,merchant_id,order_id,event_type,idempotency_key,payload)
    values('bioo_'||replace(gen_random_uuid()::text,'-',''),v_conn.id,v_conn.merchant_id,p_order_id,p_event_type,v_key,p_payload)
    on conflict(connection_id,idempotency_key) do nothing;
    if found then v_count:=v_count+1; end if;
  end loop;
  return v_count;
end $$;
revoke all on function brand_integration_enqueue_order_event(text,text,jsonb) from public;
grant execute on function brand_integration_enqueue_order_event(text,text,jsonb) to current_user;

-- Never allow a stale integration connection to remain a purchasable source.
update brand_integration_offers o set status='stale',updated_at=now()
from brand_integration_connections c
where o.connection_id=c.id and o.status='active'
  and o.last_seen_at < now() - make_interval(secs=>c.stale_after_seconds);
update products p set status='inactive',stock=0
where p.catalog_source='enterprise_api'
  and not exists(select 1 from brand_integration_offers o where o.product_id=p.id and o.status='active');


-- Purchasing must fail closed for stale distributor-backed products, even if a search/index cache is stale.
create or replace function validate_fresh_brand_product_order_item()
returns trigger language plpgsql as $$
declare v_source text; v_stock integer;
begin
  select catalog_source,stock into v_source,v_stock from products where id=new.product_id;
  if v_source='enterprise_api' then
    if v_stock <= 0 or not exists(
      select 1 from brand_integration_offers o
      join brand_integration_connections c on c.id=o.connection_id
      where o.product_id=new.product_id and o.status='active' and c.status='active'
        and o.last_seen_at >= now() - make_interval(secs=>c.stale_after_seconds)
        and o.available > 0
    ) then
      raise exception 'integration product inventory is stale or unavailable';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists fresh_brand_product_order_item_guard on order_items;
create trigger fresh_brand_product_order_item_guard
before insert on order_items for each row execute function validate_fresh_brand_product_order_item();
revoke all on function validate_fresh_brand_product_order_item() from public;
grant execute on function validate_fresh_brand_product_order_item() to current_user;
