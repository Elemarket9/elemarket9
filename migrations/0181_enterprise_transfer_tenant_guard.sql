-- Defense-in-depth: no enterprise inventory transfer can cross merchant/organization boundaries.
-- Protects direct SQL writers in addition to the enterprise API authorization checks.
create or replace function enforce_enterprise_transfer_scope()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare
  v_product_merchant text;
  v_source_merchant text;
  v_destination_merchant text;
  v_org_merchant text;
  v_source_org text;
  v_destination_org text;
begin
  if new.from_location_id = new.to_location_id then raise exception 'transfer locations must differ'; end if;
  select merchant_id into v_product_merchant from products where id=new.product_id;
  select merchant_id into v_org_merchant from enterprise_organizations where id=new.organization_id and status='active';
  select merchant_id,organization_id into v_source_merchant,v_source_org
    from merchant_inventory_locations where id=new.from_location_id and status='active';
  select merchant_id,organization_id into v_destination_merchant,v_destination_org
    from merchant_inventory_locations where id=new.to_location_id and status='active';
  if v_org_merchant is null or v_product_merchant is distinct from v_org_merchant
    or v_source_merchant is distinct from v_org_merchant or v_destination_merchant is distinct from v_org_merchant
    or v_source_org is distinct from new.organization_id or v_destination_org is distinct from new.organization_id
  then raise exception 'enterprise transfer product/location organization mismatch'; end if;
  return new;
end;
$$;

drop trigger if exists enterprise_transfer_scope_guard on enterprise_inventory_transfers;
create trigger enterprise_transfer_scope_guard
before insert or update of organization_id,product_id,from_location_id,to_location_id
on enterprise_inventory_transfers for each row execute function enforce_enterprise_transfer_scope();
