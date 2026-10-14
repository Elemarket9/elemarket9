-- v1.85: high-scale Brand & Distributor Gateway hardening.
-- Canonical Product remains marketplace identity; integration owns Offer + location inventory.

alter table brand_integration_connections add column if not exists location_id text references merchant_inventory_locations(id) on delete restrict;
alter table brand_integration_connections add column if not exists circuit_state text not null default 'closed' check (circuit_state in ('closed','open','half_open'));
alter table brand_integration_connections add column if not exists circuit_open_until timestamptz;
alter table brand_integration_connections add column if not exists consecutive_failures integer not null default 0 check (consecutive_failures>=0);
alter table brand_integration_connections add column if not exists last_health_check_at timestamptz;

create table if not exists brand_integration_credentials (
  id text primary key,
  connection_id text not null references brand_integration_connections(id) on delete cascade,
  credentials_encrypted text,
  webhook_secret_encrypted text,
  status text not null default 'active' check(status in ('active','retired','revoked')),
  activated_at timestamptz not null default now(),
  retired_at timestamptz,
  unique(connection_id,id)
);
drop index if exists brand_integration_credentials_one_active_idx;
create index if not exists brand_integration_credentials_one_active_idx on brand_integration_credentials(connection_id,status,activated_at desc);

create table if not exists brand_integration_offers (
  id text primary key,
  connection_id text not null references brand_integration_connections(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  product_id text not null references products(id) on delete cascade,
  external_product_id text not null,
  external_sku text,
  price numeric(18,2) not null check(price>0),
  currency char(3) not null default 'GHS' check(currency='GHS'),
  available integer not null default 0 check(available>=0),
  external_version bigint,
  payload_hash text not null,
  status text not null default 'active' check(status in ('active','stale','disabled')),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connection_id,external_product_id)
);
create index if not exists brand_integration_offers_product_idx on brand_integration_offers(product_id,status,price);
create index if not exists brand_integration_offers_connection_idx on brand_integration_offers(connection_id,status,last_seen_at desc);

alter table brand_integration_webhook_events add column if not exists event_identity text;
update brand_integration_webhook_events set event_identity=coalesce(external_event_id,event_type||':'||payload_hash) where event_identity is null;
alter table brand_integration_webhook_events alter column event_identity set not null;
create unique index if not exists brand_integration_webhook_identity_uq on brand_integration_webhook_events(connection_id,event_identity);

create index if not exists brand_integration_product_map_snapshot_idx on brand_integration_product_map(connection_id,status,last_seen_at);

create or replace function validate_brand_integration_location()
returns trigger language plpgsql as $$
declare v_org text; v_merchant text;
begin
  if new.location_id is null then return new; end if;
  select merchant_id,organization_id into v_merchant,v_org from merchant_inventory_locations where id=new.location_id and status='active';
  if v_merchant is null or v_merchant is distinct from new.merchant_id then raise exception 'integration location does not belong to merchant'; end if;
  if new.organization_id is not null and v_org is distinct from new.organization_id then raise exception 'integration location organization mismatch'; end if;
  return new;
end $$;
drop trigger if exists brand_integration_location_guard on brand_integration_connections;
create trigger brand_integration_location_guard before insert or update of merchant_id,organization_id,location_id on brand_integration_connections for each row execute function validate_brand_integration_location();

create or replace function apply_brand_integration_record(
  p_connection_id text,p_merchant_id text,p_location_id text,p_record jsonb
) returns table(created boolean,updated boolean,stale_rejected boolean)
language plpgsql as $$
declare
  c record; r record; m record; p_id text; offer_id text; h text; v_ext bigint; old_ver bigint; is_new boolean;
  v_name text; v_category text; v_price numeric; v_stock integer; v_currency text; v_brand text; v_model text; v_subcategory text; v_condition text; v_desc text; v_image text; v_sku text; v_gtin text; v_mpn text;
  v_key text;
begin
  select c1.* into c from brand_integration_connections c1 where c1.id=p_connection_id and c1.merchant_id=p_merchant_id for update;
  if not found or c.status<>'active' then raise exception 'integration connection inactive'; end if;
  if not exists(select 1 from merchant_brand_authorizations a where a.id=coalesce(c.authorization_id,'') and a.merchant_id=c.merchant_id and a.brand_id=c.brand_id and a.status='verified' and (a.expires_at is null or a.expires_at>now()))
     and not exists(select 1 from merchant_brand_authorizations a where a.merchant_id=c.merchant_id and a.brand_id=c.brand_id and a.status='verified' and (a.expires_at is null or a.expires_at>now())) then
    raise exception 'brand authorization expired or revoked';
  end if;
  v_name=trim(p_record->>'name'); v_category=trim(p_record->>'category'); v_price=(p_record->>'price')::numeric; v_stock=(p_record->>'stock')::integer; v_currency=upper(coalesce(p_record->>'currency','GHS'));
  if v_name='' or v_category='' or v_price<=0 or v_stock<0 or v_currency<>'GHS' then raise exception 'invalid integration record'; end if;
  v_sku=nullif(trim(p_record->>'externalSku'),''); v_brand=nullif(trim(p_record->>'brand'),''); v_model=nullif(trim(p_record->>'model'),''); v_subcategory=nullif(trim(p_record->>'subcategory'),''); v_condition=nullif(trim(p_record->>'condition'),''); v_desc=coalesce(p_record->>'description',''); v_image=nullif(trim(p_record->>'imageUrl'),''); v_gtin=nullif(trim(p_record->>'gtin'),''); v_mpn=nullif(trim(p_record->>'mpn'),'');
  v_ext=case when (p_record ? 'externalVersion') and nullif(p_record->>'externalVersion','') is not null then (p_record->>'externalVersion')::bigint else null end;
  h=encode(digest(p_record::text,'sha256'),'hex');
  select product_id,external_version into m from brand_integration_product_map where connection_id=p_connection_id and external_product_id=trim(p_record->>'externalProductId') for update;
  if m.external_version is not null and v_ext is not null and v_ext<m.external_version then return query select false,false,true; return; end if;
  p_id=m.product_id;
  if p_id is null and v_gtin is not null then select pi.product_id into p_id from product_identifiers pi where pi.identifier_type in ('gtin12','gtin13','gtin14','upc','ean') and pi.normalized_value=lower(regexp_replace(v_gtin,'[^a-zA-Z0-9]','','g')) limit 1; end if;
  if p_id is null and v_mpn is not null then select pi.product_id into p_id from product_identifiers pi where pi.identifier_type='mpn' and pi.normalized_value=lower(regexp_replace(v_mpn,'[^a-zA-Z0-9]','','g')) limit 1; end if;
  is_new:=p_id is null;
  v_key=coalesce(nullif(lower(regexp_replace(v_gtin,'[^a-zA-Z0-9]','','g')),''),nullif(lower(regexp_replace(coalesce(v_brand,'')||':'||coalesce(v_model,''),'[^a-zA-Z0-9:]','','g')),''),lower(regexp_replace(v_name,'[^a-zA-Z0-9]','','g')));
  if is_new then
    p_id='p_'||replace(gen_random_uuid()::text,'-','');
    insert into products(id,merchant_id,name,category,price,currency,stock,description,image_path,created_at,catalog_source,external_product_id,external_sku,external_updated_at,brand_id,model,subcategory,condition,attributes,canonical_product_key)
    values(p_id,c.merchant_id,v_name,v_category,v_price,'GHS',v_stock,v_desc,v_image,now(),'enterprise_api',trim(p_record->>'externalProductId'),v_sku,now(),c.brand_id,v_model,v_subcategory,v_condition,coalesce(p_record->'attributes','{}'::jsonb),v_key);
  else
    update products set name=v_name,category=v_category,description=v_desc,image_path=v_image,external_sku=v_sku,external_updated_at=now(),brand_id=c.brand_id,model=v_model,subcategory=v_subcategory,condition=v_condition,attributes=coalesce(p_record->'attributes','{}'::jsonb),canonical_product_key=coalesce(canonical_product_key,v_key) where id=p_id and merchant_id=c.merchant_id;
  end if;
  insert into brand_integration_offers(id,connection_id,merchant_id,product_id,external_product_id,external_sku,price,currency,available,external_version,payload_hash,status,last_seen_at,updated_at)
  values('bio_'||replace(gen_random_uuid()::text,'-',''),p_connection_id,c.merchant_id,p_id,trim(p_record->>'externalProductId'),v_sku,v_price,'GHS',v_stock,v_ext,h,'active',now(),now())
  on conflict(connection_id,external_product_id) do update set product_id=excluded.product_id,external_sku=excluded.external_sku,price=excluded.price,available=excluded.available,external_version=excluded.external_version,payload_hash=excluded.payload_hash,status='active',last_seen_at=now(),updated_at=now()
  returning id into offer_id;
  if p_location_id is not null then
    insert into product_location_inventory(id,product_id,location_id,available,reserved,safety_stock,version,updated_at)
    values('pli_'||replace(gen_random_uuid()::text,'-',''),p_id,p_location_id,v_stock,0,0,1,now())
    on conflict(product_id,location_id) do update set available=excluded.available,version=product_location_inventory.version+1,updated_at=now();
    update products set stock=(select coalesce(sum(greatest(available-reserved-safety_stock,0)),0) from product_location_inventory where product_id=p_id) where id=p_id;
  else update products set price=v_price,stock=v_stock where id=p_id;
  end if;
  insert into brand_integration_product_map(id,connection_id,merchant_id,external_product_id,external_sku,product_id,payload_hash,external_version,last_seen_at,last_synced_at,status)
  values('bigpm_'||replace(gen_random_uuid()::text,'-',''),p_connection_id,c.merchant_id,trim(p_record->>'externalProductId'),v_sku,p_id,h,v_ext,now(),now(),'active')
  on conflict(connection_id,external_product_id) do update set external_sku=excluded.external_sku,product_id=excluded.product_id,payload_hash=excluded.payload_hash,external_version=excluded.external_version,last_seen_at=now(),last_synced_at=now(),status='active';
  if v_gtin is not null then insert into product_identifiers(id,product_id,identifier_type,identifier_value,source,verified) values('bigi_'||replace(gen_random_uuid()::text,'-',''),p_id,case when length(regexp_replace(v_gtin,'[^0-9]','','g'))=12 then 'gtin12' when length(regexp_replace(v_gtin,'[^0-9]','','g'))=13 then 'gtin13' when length(regexp_replace(v_gtin,'[^0-9]','','g'))=14 then 'gtin14' else 'ean' end,v_gtin,'enterprise_feed',false) on conflict(product_id,identifier_type,normalized_value) do update set identifier_value=excluded.identifier_value,updated_at=now(); end if;
  if v_mpn is not null then insert into product_identifiers(id,product_id,identifier_type,identifier_value,source,verified) values('bigi_'||replace(gen_random_uuid()::text,'-',''),p_id,'mpn',v_mpn,'enterprise_feed',false) on conflict(product_id,identifier_type,normalized_value) do update set identifier_value=excluded.identifier_value,updated_at=now(); end if;
  return query select is_new,not is_new,false;
end $$;
revoke all on function apply_brand_integration_record(text,text,text,jsonb) from public;
grant execute on function apply_brand_integration_record(text,text,text,jsonb) to current_user;

create index if not exists brand_integration_offer_location_product_idx on product_location_inventory(product_id,location_id,updated_at desc);

-- A single connection may not be synchronized concurrently. Leases expire after 5 minutes.
alter table brand_integration_connections add column if not exists sync_lease_owner text;
alter table brand_integration_connections add column if not exists sync_lease_until timestamptz;

-- Authorization is time-sensitive: operational paths must validate expires_at at runtime.
comment on column brand_integration_connections.location_id is 'Optional authoritative enterprise inventory location for this distributor feed.';
comment on table brand_integration_offers is 'Distributor-owned marketplace offer; canonical product identity remains separate.';
comment on table brand_integration_credentials is 'Versioned integration credentials enabling zero-downtime rotation.';
