-- v1.87 production marketplace control plane.
-- Real-world marketplace hardening benchmarked against eBay/Walmart/Amazon
-- patterns: seller-controlled order state must not manufacture delivery proof,
-- and legacy local-custody/escrow paths must be impossible in production.

-- ---------------------------------------------------------------------------
-- 1. Remove the historical escrow execution path.
-- ---------------------------------------------------------------------------
-- ELEMARKET is non-custodial. Historical escrow tables/functions remain only
-- for migration compatibility/audit history; they are not a live money-flow.
drop trigger if exists payment_completed_escrow_create on payments;
drop trigger if exists payment_refund_escrow_guard on payments;
drop trigger if exists payment_refunded_escrow_finalize on payments;
drop trigger if exists payment_refund_escrow_sync on payments;

create or replace function create_escrow_for_completed_payment()
returns trigger language plpgsql as $$
begin
  raise exception 'legacy escrow execution is disabled; payment settlement remains provider-managed';
end;
$$;
create or replace function release_escrow(p_escrow_id text, p_reference text)
returns jsonb language plpgsql as $$
begin
  raise exception 'legacy escrow release is disabled; merchant settlement remains provider-managed';
end;
$$;
create or replace function create_settlement_attempt(p_settlement_id text,p_provider_key text)
returns jsonb language plpgsql as $$
begin
  raise exception 'legacy local settlement is disabled; use the external payment provider';
end;
$$;

-- Legacy fund-release functions previously reserved amounts against escrow
-- rows. They must not become a hidden local payout API after this migration.
drop function if exists create_merchant_fund_release_request(text,numeric,text,text);
drop function if exists create_merchant_fund_release_request(text,numeric,text);
drop function if exists review_merchant_fund_release_request(text,text,text,text);

revoke all on function create_escrow_for_completed_payment() from public;
revoke all on function release_escrow(text,text) from public;
revoke all on function create_settlement_attempt(text,text) from public;

-- Provider eligibility is a marketplace decision only: it reads the live order
-- and dispute state, never an ELEMARKET-held balance.
create or replace view merchant_provider_funds_summary as
select m.id merchant_id,
       m.name merchant_name,
       coalesce(e.eligible_amount,0)::numeric(12,2) provider_held_eligible_amount,
       coalesce(e.eligible_amount,0)::numeric(12,2) provider_requestable_amount
from merchants m
left join lateral (
  select coalesce(sum(o.merchant_net),0)::numeric(12,2) eligible_amount
    from orders o
   where o.merchant_id=m.id
     and o.status in ('delivered','completed')
     and elemarket_order_delivered_at(o.id) is not null
     and now() >= elemarket_order_delivered_at(o.id) + interval '24 hours'
     and not exists (select 1 from customer_order_disputes d where d.order_id=o.id and d.status in ('open','under_review'))
     and not exists (select 1 from customer_order_disputes d where d.order_id=o.id and d.created_at <= elemarket_order_delivered_at(o.id) + interval '24 hours')
) e on true;

create or replace view merchant_financial_summary as
select m.id merchant_id,
       m.name merchant_name,
       0::numeric(12,2) held_amount,
       0::numeric(12,2) available_amount,
       0::numeric(12,2) payout_processing,
       0::numeric(12,2) paid_out,
       coalesce(sum(case when o.status <> 'cancelled' then o.product_total else 0 end),0)::numeric(12,2) total_sales,
       0::numeric(12,2) pending_amount,
       0::numeric(12,2) disputed_amount,
       coalesce(v.provider_held_eligible_amount,0)::numeric(12,2) provider_held_eligible_amount,
       coalesce(v.provider_requestable_amount,0)::numeric(12,2) provider_requestable_amount
from merchants m
left join orders o on o.merchant_id=m.id
left join merchant_provider_funds_summary v on v.merchant_id=m.id
group by m.id,m.name,v.provider_held_eligible_amount,v.provider_requestable_amount;

-- ---------------------------------------------------------------------------
-- 2. Delivery proof: a merchant cannot self-certify delivery.
-- ---------------------------------------------------------------------------
alter table orders add column if not exists delivery_confirmation_source text;
alter table orders add column if not exists customer_received_at timestamptz;
alter table orders drop constraint if exists orders_delivery_confirmation_source_check;
alter table orders add constraint orders_delivery_confirmation_source_check
  check (delivery_confirmation_source is null or delivery_confirmation_source in ('carrier_webhook','customer_confirmation')) not valid;
create index if not exists orders_delivery_confirmation_idx
  on orders(delivery_confirmation_source,customer_received_at)
  where delivery_confirmation_source is not null;

create or replace function customer_confirm_order_received(
  p_order_id text,p_customer_id text
) returns jsonb language plpgsql as $$
declare v_order record; v_delivered_at timestamptz;
begin
  if p_order_id is null or length(trim(p_order_id)) < 1 then raise exception 'order required'; end if;
  if p_customer_id is null or length(trim(p_customer_id)) < 1 then raise exception 'customer identity required'; end if;
  select * into v_order from orders where id=p_order_id and user_id=p_customer_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.status not in ('shipped') then raise exception 'order is not awaiting customer delivery confirmation'; end if;

  v_delivered_at:=now();
  update orders
     set status='delivered',delivery_confirmation_source='customer_confirmation',customer_received_at=v_delivered_at,updated_at=v_delivered_at
   where id=v_order.id;
  insert into merchant_order_status_history(order_id,merchant_id,from_status,to_status,actor_user_id,note)
  values(v_order.id,v_order.merchant_id,v_order.status,'delivered',p_customer_id,'Customer confirmed receipt');
  perform record_audit_event('customer.order.received','order',v_order.id,p_customer_id,'customer',null,'success',jsonb_build_object('source','customer_confirmation'));
  return jsonb_build_object('orderId',v_order.id,'status','delivered','deliveredAt',v_delivered_at,'confirmationSource','customer_confirmation');
end;
$$;
revoke all on function customer_confirm_order_received(text,text) from public;
grant execute on function customer_confirm_order_received(text,text) to current_user;

create or replace function merchant_advance_order(
  p_merchant_id text,p_order_id text,p_to_status text,p_actor_user_id text,p_note text default null
) returns jsonb language plpgsql as $$
declare v_order record; v_allowed boolean:=false; v_carrier_delivered boolean:=false;
begin
  perform assert_actor_role(p_actor_user_id,'merchant');
  if p_to_status not in ('confirmed','fulfilling','shipped','delivered','completed') then raise exception 'invalid merchant order status'; end if;
  select * into v_order from orders where id=p_order_id and merchant_id=p_merchant_id for update;
  if not found then raise exception 'order not found'; end if;
  v_allowed:=(v_order.status,p_to_status) in (('paid','confirmed'),('confirmed','fulfilling'),('fulfilling','shipped'),('shipped','delivered'),('delivered','completed'));
  if not v_allowed then raise exception 'invalid order status transition'; end if;

  if p_to_status='delivered' then
    select exists(
      select 1
        from shipments s
        join shipment_items si on si.shipment_id=s.id
        join shipment_events se on se.shipment_id=s.id and se.event_type='delivered'
       where s.order_id=v_order.id
         and s.merchant_id=v_order.merchant_id
         and s.status='delivered'
    ) into v_carrier_delivered;
    if not v_carrier_delivered and v_order.delivery_confirmation_source is distinct from 'customer_confirmation' then
      raise exception 'delivery must be confirmed by the customer or a verified carrier event';
    end if;
  end if;

  update orders set status=p_to_status,updated_at=now() where id=p_order_id;
  insert into merchant_order_status_history(order_id,merchant_id,from_status,to_status,actor_user_id,note)
  values(p_order_id,p_merchant_id,v_order.status,p_to_status,p_actor_user_id,nullif(left(trim(coalesce(p_note,'')),500),''));
  perform record_audit_event('merchant.order.status_changed','order',p_order_id,p_actor_user_id,'merchant',null,'success',jsonb_build_object('merchantId',p_merchant_id,'from',v_order.status,'to',p_to_status,'deliveryProof',case when p_to_status='delivered' then case when v_carrier_delivered then 'carrier_webhook' else 'customer_confirmation' end else null end));
  return jsonb_build_object('orderId',p_order_id,'fromStatus',v_order.status,'status',p_to_status);
end;
$$;
revoke all on function merchant_advance_order(text,text,text,text,text) from public;
grant execute on function merchant_advance_order(text,text,text,text,text) to current_user;

comment on column orders.delivery_confirmation_source is 'Production delivery proof source. Merchant self-attestation is not accepted.';
comment on function customer_confirm_order_received(text,text) is 'Customer receipt confirmation. Starts the 24-hour provider-withdrawal protection clock.';
comment on function merchant_advance_order(text,text,text,text,text) is 'Merchant order transition with delivery proof gate; provider settlement remains external.';

-- ---------------------------------------------------------------------------
-- 3. Enterprise catalog authority: feed data cannot impersonate a brand.
-- ---------------------------------------------------------------------------
create or replace function enforce_enterprise_product_authority()
returns trigger language plpgsql as $$
declare v_brand_name text; v_authorized boolean;
begin
  if new.catalog_source='enterprise_api' then
    if new.brand_id is null then raise exception 'enterprise catalogue product requires a canonical brand'; end if;
    select b.name into v_brand_name from brands b where b.id=new.brand_id and b.status='active';
    if v_brand_name is null then raise exception 'enterprise catalogue brand is not active'; end if;
    select exists(
      select 1 from merchant_brand_authorizations a
       where a.merchant_id=new.merchant_id and a.brand_id=new.brand_id
         and a.status='verified' and (a.expires_at is null or a.expires_at>now())
    ) into v_authorized;
    if not v_authorized then raise exception 'enterprise catalogue brand authorization is not active'; end if;
    -- The feed may describe the product, but the marketplace controls the
    -- canonical brand identity. Never accept a spoofed brand string.
    new.brand:=v_brand_name;
  end if;
  if new.condition is not null and new.condition not in ('new','refurbished','used','open_box') then
    raise exception 'invalid canonical product condition';
  end if;
  return new;
end;
$$;
drop trigger if exists enterprise_product_authority_guard on products;
create trigger enterprise_product_authority_guard
before insert or update of catalog_source,merchant_id,brand_id,brand,condition on products
for each row execute function enforce_enterprise_product_authority();
