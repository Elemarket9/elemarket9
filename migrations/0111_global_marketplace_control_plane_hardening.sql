-- v1.81: marketplace control-plane hardening.
-- Closes cross-object integrity and idempotency gaps found in enterprise-scale audit.

-- -----------------------------------------------------------------------------
-- 1. Bind enterprise inventory idempotency keys to their exact operation.
-- -----------------------------------------------------------------------------
alter table enterprise_inventory_ledger
  add column if not exists operation_fingerprint text;

create index if not exists enterprise_inventory_ledger_idem_idx
  on enterprise_inventory_ledger(organization_id,idempotency_key);

create or replace function reserve_enterprise_inventory(
  p_organization_id text,p_location_id text,p_product_id text,p_quantity integer,p_reference_id text,p_idempotency_key text
) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v record; v_existing record; v_fingerprint text;
begin
  if p_quantity <= 0 then raise exception 'invalid reservation quantity'; end if;
  if p_idempotency_key is null or length(p_idempotency_key)<16 then raise exception 'invalid idempotency key'; end if;
  v_fingerprint := encode(digest(concat_ws('|','reserve',p_location_id,p_product_id,p_quantity,p_reference_id),'sha256'),'hex');
  select * into v_existing from enterprise_inventory_ledger
   where organization_id=p_organization_id and idempotency_key=p_idempotency_key
   order by created_at desc limit 1;
  if found then
    if v_existing.operation_fingerprint is distinct from v_fingerprint then raise exception 'idempotency key payload mismatch'; end if;
    return abs(v_existing.quantity);
  end if;
  select i.* into v from product_location_inventory i
   join merchant_inventory_locations l on l.id=i.location_id
   where i.product_id=p_product_id and i.location_id=p_location_id and l.organization_id=p_organization_id and l.status='active'
   for update;
  if not found then raise exception 'inventory location not found'; end if;
  if v.available - v.reserved - p_quantity < v.safety_stock then raise exception 'insufficient location inventory'; end if;
  update product_location_inventory set reserved=reserved+p_quantity,version=version+1,updated_at=now() where id=v.id;
  insert into enterprise_inventory_ledger(id,organization_id,location_id,product_id,movement_type,quantity,reference_type,reference_id,idempotency_key,operation_fingerprint,actor_user_id)
  values('eil_'||replace(gen_random_uuid()::text,'-',''),p_organization_id,p_location_id,p_product_id,'reserve',p_quantity,'order',p_reference_id,p_idempotency_key,v_fingerprint,current_setting('app.user_id',true));
  return p_quantity;
end $$;

create or replace function release_enterprise_inventory(
  p_organization_id text,p_location_id text,p_product_id text,p_quantity integer,p_reference_id text,p_idempotency_key text
) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v record; v_existing record; v_fingerprint text;
begin
  if p_quantity <= 0 then raise exception 'invalid release quantity'; end if;
  if p_idempotency_key is null or length(p_idempotency_key)<16 then raise exception 'invalid idempotency key'; end if;
  v_fingerprint := encode(digest(concat_ws('|','release',p_location_id,p_product_id,p_quantity,p_reference_id),'sha256'),'hex');
  select * into v_existing from enterprise_inventory_ledger
   where organization_id=p_organization_id and idempotency_key=p_idempotency_key
   order by created_at desc limit 1;
  if found then
    if v_existing.operation_fingerprint is distinct from v_fingerprint then raise exception 'idempotency key payload mismatch'; end if;
    return abs(v_existing.quantity);
  end if;
  select i.* into v from product_location_inventory i
   join merchant_inventory_locations l on l.id=i.location_id
   where i.product_id=p_product_id and i.location_id=p_location_id and l.organization_id=p_organization_id and l.status='active'
   for update;
  if not found or v.reserved < p_quantity then raise exception 'invalid inventory release'; end if;
  update product_location_inventory set reserved=reserved-p_quantity,version=version+1,updated_at=now() where id=v.id;
  insert into enterprise_inventory_ledger(id,organization_id,location_id,product_id,movement_type,quantity,reference_type,reference_id,idempotency_key,operation_fingerprint,actor_user_id)
  values('eil_'||replace(gen_random_uuid()::text,'-',''),p_organization_id,p_location_id,p_product_id,'release',-p_quantity,'order',p_reference_id,p_idempotency_key,v_fingerprint,current_setting('app.user_id',true));
  return p_quantity;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Serialized units: strict enterprise/product/location consistency.
-- -----------------------------------------------------------------------------
create or replace function validate_enterprise_serial_unit()
returns trigger language plpgsql as $$
declare v_org text; v_merchant text; v_product_merchant text; v_enterprise_merchant text;
begin
  select organization_id,merchant_id into v_org,v_merchant
  from merchant_inventory_locations where id=new.location_id;
  select merchant_id into v_product_merchant from products where id=new.product_id;
  select merchant_id into v_enterprise_merchant from enterprise_organizations where id=new.organization_id and status='active';
  if new.location_id is not null and (v_org is null or v_org is distinct from new.organization_id or v_merchant is distinct from v_product_merchant) then
    raise exception 'serial unit location/product organization mismatch';
  end if;
  if v_product_merchant is null or v_enterprise_merchant is null or v_product_merchant is distinct from v_enterprise_merchant then
    raise exception 'serial unit product organization mismatch';
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- 3. Fulfillment allocations: lock the order item before quantity validation.
-- -----------------------------------------------------------------------------
create or replace function validate_enterprise_fulfillment_allocation()
returns trigger language plpgsql as $$
declare v_org text; v_order_merchant text; v_location_merchant text; v_order text; v_item_qty integer; v_alloc integer;
begin
  select o.id,o.merchant_id,oi.quantity into v_order,v_order_merchant,v_item_qty
  from orders o join order_items oi on oi.order_id=o.id
  where oi.id=new.order_item_id
  for update of o;
  if v_order is null then raise exception 'order item not found'; end if;
  select organization_id,merchant_id into v_org,v_location_merchant from merchant_inventory_locations where id=new.location_id and status='active';
  if v_org is distinct from new.organization_id then raise exception 'allocation organization mismatch'; end if;
  if v_location_merchant is distinct from v_order_merchant then raise exception 'allocation merchant mismatch'; end if;
  select coalesce(sum(quantity),0)::int into v_alloc
  from enterprise_fulfillment_allocations
  where order_item_id=new.order_item_id and status not in ('released','cancelled') and id<>coalesce(new.id,'');
  if v_alloc + new.quantity > v_item_qty then raise exception 'fulfillment allocation exceeds ordered quantity'; end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Service cases: bind product/serial/order-item consistently.
-- -----------------------------------------------------------------------------
create or replace function validate_enterprise_service_case()
returns trigger language plpgsql as $$
declare v_org text; v_order_user text; v_order_product text; v_item_product text; v_product_merchant text; v_serial_org text; v_serial_product text;
begin
  if new.service_location_id is not null then
    select organization_id into v_org from merchant_inventory_locations where id=new.service_location_id and status='active';
    if v_org is distinct from new.organization_id then raise exception 'service location organization mismatch'; end if;
  end if;
  if new.order_id is not null then
    select user_id into v_order_user from orders where id=new.order_id;
    if v_order_user is distinct from new.customer_user_id then raise exception 'service case customer/order mismatch'; end if;
  end if;
  if new.order_item_id is not null then
    select oi.product_id into v_item_product from order_items oi where oi.id=new.order_item_id and oi.order_id=new.order_id;
    if v_item_product is null then raise exception 'service case order item mismatch'; end if;
    if new.product_id is not null and new.product_id is distinct from v_item_product then raise exception 'service case product/order item mismatch'; end if;
    if new.product_id is null then new.product_id := v_item_product; end if;
  end if;
  if new.product_id is not null then
    select p.merchant_id into v_product_merchant from products p join enterprise_organizations e on e.merchant_id=p.merchant_id where p.id=new.product_id and e.id=new.organization_id and e.status='active';
    if v_product_merchant is null then raise exception 'service case product organization mismatch'; end if;
  end if;
  if new.serial_unit_id is not null then
    select organization_id,product_id into v_serial_org,v_serial_product from enterprise_serial_units where id=new.serial_unit_id;
    if v_serial_org is distinct from new.organization_id then raise exception 'service case serial organization mismatch'; end if;
    if new.product_id is null or v_serial_product is distinct from new.product_id then raise exception 'service case serial/product mismatch'; end if;
  end if;
  return new;
end $$;

drop trigger if exists enterprise_service_case_guard on enterprise_service_cases;
create trigger enterprise_service_case_guard
before insert or update of organization_id,customer_user_id,order_id,order_item_id,product_id,serial_unit_id,service_location_id
on enterprise_service_cases for each row execute function validate_enterprise_service_case();

-- -----------------------------------------------------------------------------
-- 5. Enterprise transfer integrity: both nodes must belong to the same org/merchant.
-- -----------------------------------------------------------------------------
create or replace function validate_enterprise_inventory_transfer()
returns trigger language plpgsql as $$
declare f_org text; f_merchant text; t_org text; t_merchant text; p_merchant text; e_merchant text;
begin
  select organization_id,merchant_id into f_org,f_merchant from merchant_inventory_locations where id=new.from_location_id;
  select organization_id,merchant_id into t_org,t_merchant from merchant_inventory_locations where id=new.to_location_id;
  select merchant_id into p_merchant from products where id=new.product_id;
  select merchant_id into e_merchant from enterprise_organizations where id=new.organization_id and status='active';
  if f_org is distinct from new.organization_id or t_org is distinct from new.organization_id then raise exception 'transfer location organization mismatch'; end if;
  if f_merchant is distinct from p_merchant or t_merchant is distinct from p_merchant or p_merchant is distinct from e_merchant then raise exception 'transfer merchant/product mismatch'; end if;
  if f_merchant is null or t_merchant is null or p_merchant is null then raise exception 'transfer references missing'; end if;
  return new;
end $$;
drop trigger if exists enterprise_inventory_transfer_guard on enterprise_inventory_transfers;
create trigger enterprise_inventory_transfer_guard
before insert or update of organization_id,product_id,from_location_id,to_location_id
on enterprise_inventory_transfers for each row execute function validate_enterprise_inventory_transfer();

comment on column enterprise_inventory_ledger.operation_fingerprint is 'Binds an idempotency key to the exact inventory operation payload; replay with different parameters is rejected.';
