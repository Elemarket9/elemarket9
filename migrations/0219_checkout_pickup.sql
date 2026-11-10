-- Pickup at checkout.
--
-- The customer chooses door delivery or a pickup point while quoting delivery.
-- A pickup quote is priced to the pickup point and carries pickup_location_id;
-- the order's delivery address is the pickup point's address, so the existing
-- order/quote address binding in create_pending_order is unchanged. Dispatch
-- creates a 'pickup' delivery job for that point, and the existing parcel
-- arrival, collection notice and attendant OTP handover apply.
--
-- Pickup jobs previously required a shipment record (0205), which ordinary
-- orders never have, so pickup could not be used. A pickup job without a
-- shipment is now accepted when the order's purchased quote names exactly that
-- pickup point and the point belongs to the job's delivery company.

alter table delivery_quotes add column if not exists pickup_location_id text references pickup_locations(id) on delete restrict;
create index if not exists delivery_quotes_pickup_location on delivery_quotes(pickup_location_id) where pickup_location_id is not null;

create or replace function elemarket_guard_delivery_quote_pickup() returns trigger language plpgsql as $$
begin
  if new.pickup_location_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.pickup_location_id is not distinct from old.pickup_location_id then return new; end if;
  if tg_op = 'UPDATE' then raise exception 'delivery quote pickup point is immutable'; end if;
  if new.provider_id is null or not exists(
       select 1 from pickup_locations l
         join delivery_providers p on p.partner_organization_id = l.organization_id
        where l.id = new.pickup_location_id and l.status = 'active' and p.id = new.provider_id and p.status = 'active') then
    raise exception 'pickup point is not served by this delivery company';
  end if;
  if new.dest_address is distinct from (select address from pickup_locations where id = new.pickup_location_id) then
    raise exception 'pickup quote must be addressed to the pickup point';
  end if;
  return new;
end $$;
drop trigger if exists delivery_quote_pickup_guard on delivery_quotes;
create trigger delivery_quote_pickup_guard before insert or update of pickup_location_id, provider_id, dest_address on delivery_quotes
  for each row execute function elemarket_guard_delivery_quote_pickup();

create or replace function elemarket_guard_pickup_job() returns trigger language plpgsql as $$
declare org_id text;
begin
 select partner_organization_id into org_id from delivery_providers where id=new.provider_id;
 if new.handover_kind='pickup' then
  if new.shipment_id is not null then
   if not exists(select 1 from pickup_locations l
     join shipments s on s.id=new.shipment_id and s.pickup_location_id=l.id and s.fulfillment_method='pickup'
     where l.id=new.pickup_location_id and l.organization_id=org_id) then raise exception 'pickup parcel/location/provider mismatch'; end if;
  else
   -- Every write: the point must belong to the job's (possibly reassigned) company.
   if not exists(select 1 from pickup_locations l where l.id=new.pickup_location_id and l.organization_id=org_id) then
    raise exception 'pickup parcel/location/provider mismatch'; end if;
   -- Creation: the point must be the one the customer bought.
   if tg_op='INSERT' and not exists(select 1 from orders o
      join delivery_quotes q on q.id=o.delivery_quote_id and q.pickup_location_id=new.pickup_location_id
      where o.id=new.order_id) then
    raise exception 'pickup parcel/location/provider mismatch'; end if;
  end if;
 elsif tg_op='INSERT' and new.shipment_id is null and exists(select 1 from orders o join delivery_quotes q on q.id=o.delivery_quote_id
     where o.id=new.order_id and q.pickup_location_id is not null) then
  raise exception 'order was bought for pickup; door delivery job refused';
 end if;
 if tg_op='UPDATE' and (new.handover_kind is distinct from old.handover_kind or new.pickup_location_id is distinct from old.pickup_location_id) then
   raise exception 'handover fulfillment identity is immutable'; end if;
 if tg_op='UPDATE' and old.pickup_arrived_at is not null and new.pickup_arrived_at is distinct from old.pickup_arrived_at then
   raise exception 'parcel arrival history is immutable'; end if;
 return new;
end $$;
