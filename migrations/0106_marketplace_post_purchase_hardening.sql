-- v1.76: post-purchase marketplace hardening.
-- Adds provider-neutral returns, verified-purchase reviews and seller performance
-- signals. ELEMARKET never holds customer funds; approved refunds remain provider-managed.

create table if not exists return_requests (
  id text primary key,
  order_id text not null references orders(id) on delete restrict,
  order_item_id bigint not null references order_items(id) on delete restrict,
  customer_id text not null,
  merchant_id text not null references merchants(id) on delete restrict,
  reason_code text not null check (reason_code in ('changed_mind','wrong_item','damaged','defective','not_as_described','missing_parts','other')),
  reason text not null check (char_length(trim(reason)) between 8 and 2000),
  quantity integer not null check (quantity between 1 and 20),
  status text not null default 'requested' check (status in ('requested','approved','rejected','received','refund_pending','refunded','cancelled')),
  resolution_note text,
  resolved_by text,
  provider_refund_request_id text references provider_refund_requests(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists return_requests_customer_idx on return_requests(customer_id,created_at desc);
create index if not exists return_requests_merchant_idx on return_requests(merchant_id,status,created_at desc);
create index if not exists return_requests_order_idx on return_requests(order_id,created_at desc);
create unique index if not exists return_requests_active_item_uq
  on return_requests(order_item_id)
  where status in ('requested','approved','received','refund_pending');

create table if not exists review_responses (
  id text primary key,
  review_id text not null references reviews(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete restrict,
  body text not null check (char_length(trim(body)) between 2 and 1000),
  actor_user_id text not null,
  created_at timestamptz not null default now(),
  unique(review_id)
);

create index if not exists reviews_product_created_idx on reviews(product_id,created_at desc);
create index if not exists reviews_order_idx on reviews(order_id,created_at desc);

create or replace function request_order_return(
  p_order_id text,
  p_order_item_id bigint,
  p_customer_id text,
  p_reason_code text,
  p_reason text,
  p_quantity integer
) returns jsonb language plpgsql as $$
declare
  v_order record; v_item record; v_product record; v_existing record; v_id text;
begin
  if p_customer_id is null or length(trim(p_customer_id)) < 1 then raise exception 'customer identity required'; end if;
  if p_reason_code not in ('changed_mind','wrong_item','damaged','defective','not_as_described','missing_parts','other') then raise exception 'invalid return reason'; end if;
  if p_reason is null or length(trim(p_reason)) < 8 or length(trim(p_reason)) > 2000 then raise exception 'return reason must be 8-2000 characters'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then raise exception 'invalid return quantity'; end if;

  select o.* into v_order from orders o where o.id=p_order_id and o.user_id=p_customer_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.status not in ('delivered','completed') then raise exception 'only delivered orders can be returned'; end if;
  if exists(select 1 from customer_order_disputes d where d.order_id=v_order.id and d.status in ('open','under_review')) then raise exception 'resolve the active order dispute before creating a return'; end if;

  select oi.*,p.returnable,p.return_window_days,p.merchant_id,p.name into v_item
    from order_items oi join products p on p.id=oi.product_id
   where oi.id=p_order_item_id and oi.order_id=p_order_id for update;
  if not found then raise exception 'order item not found'; end if;
  if p_quantity > v_item.quantity then raise exception 'return quantity exceeds purchased quantity'; end if;
  if v_item.returnable is not true then raise exception 'this item is not returnable'; end if;
  if v_item.return_window_days is null or now() > elemarket_order_delivered_at(v_order.id) + make_interval(days=>v_item.return_window_days) then raise exception 'return window has expired'; end if;

  select id,status into v_existing from return_requests where order_item_id=p_order_item_id and status in ('requested','approved','received','refund_pending') limit 1 for update;
  if found then
    return jsonb_build_object('returnId',v_existing.id,'status',v_existing.status,'existing',true);
  end if;

  if p_quantity > v_item.quantity then raise exception 'invalid return quantity'; end if;
  v_id:='ret_'||replace(gen_random_uuid()::text,'-','');
  insert into return_requests(id,order_id,order_item_id,customer_id,merchant_id,reason_code,reason,quantity)
  values(v_id,p_order_id,p_order_item_id,p_customer_id,v_item.merchant_id,p_reason_code,left(trim(p_reason),2000),p_quantity);
  perform record_audit_event('customer.return.requested','return_request',v_id,p_customer_id,'customer',null,'success',jsonb_build_object('orderId',p_order_id,'orderItemId',p_order_item_id,'merchantId',v_item.merchant_id,'reasonCode',p_reason_code,'quantity',p_quantity));
  return jsonb_build_object('returnId',v_id,'orderId',p_order_id,'orderItemId',p_order_item_id,'status','requested','existing',false);
end;
$$;

create or replace function review_order_item(
  p_order_id text,
  p_product_id text,
  p_customer_id text,
  p_rating integer,
  p_body text
) returns jsonb language plpgsql as $$
declare
  v_order record; v_id text;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'rating must be 1-5'; end if;
  if p_body is null or length(trim(p_body)) < 8 or length(trim(p_body)) > 1000 then raise exception 'review must be 8-1000 characters'; end if;
  select o.* into v_order from orders o where o.id=p_order_id and o.user_id=p_customer_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.status not in ('delivered','completed') then raise exception 'only delivered orders can be reviewed'; end if;
  if not exists(select 1 from order_items oi where oi.order_id=p_order_id and oi.product_id=p_product_id) then raise exception 'product was not purchased in this order'; end if;
  if not exists(select 1 from payments p where p.order_id=p_order_id and p.status='completed') then raise exception 'paid order required'; end if;
  if exists(select 1 from reviews r where r.user_id=p_customer_id and r.order_id=p_order_id and r.product_id=p_product_id) then raise exception 'review already exists'; end if;
  v_id:='rev_'||replace(gen_random_uuid()::text,'-','');
  insert into reviews(id,user_id,product_id,order_id,rating,body) values(v_id,p_customer_id,p_product_id,p_order_id,p_rating,left(trim(p_body),1000));
  perform record_audit_event('customer.review.created','review',v_id,p_customer_id,'customer',null,'success',jsonb_build_object('orderId',p_order_id,'productId',p_product_id,'rating',p_rating));
  return jsonb_build_object('reviewId',v_id,'verifiedPurchase',true);
end;
$$;

create or replace function merchant_performance_snapshot(p_merchant_id text)
returns jsonb language sql stable as $$
with scope as (
  select o.id,o.status,o.created_at,o.updated_at,
    exists(select 1 from merchant_order_status_history h where h.order_id=o.id and h.to_status='shipped') as shipped,
    exists(select 1 from merchant_order_status_history h where h.order_id=o.id and h.to_status='delivered') as delivered
  from orders o where o.merchant_id=p_merchant_id and o.created_at >= now()-interval '90 days'
),
reviews_agg as (select coalesce(avg(r.rating),0)::numeric(4,2) avg_rating,count(*)::int review_count from reviews r join products p on p.id=r.product_id where p.merchant_id=p_merchant_id and r.created_at>=now()-interval '90 days'),
returns_agg as (select count(*)::int return_count from return_requests rr where rr.merchant_id=p_merchant_id and rr.created_at>=now()-interval '90 days'),
disputes_agg as (select count(*)::int dispute_count from customer_order_disputes d join orders o on o.id=d.order_id where o.merchant_id=p_merchant_id and d.created_at>=now()-interval '90 days')
select jsonb_build_object(
  'windowDays',90,
  'orders',count(*)::int,
  'completedOrders',count(*) filter(where status in ('delivered','completed'))::int,
  'cancellations',count(*) filter(where status='cancelled')::int,
  'cancellationRate',case when count(*)=0 then 0 else round((count(*) filter(where status='cancelled')::numeric/count(*)::numeric)*100,2) end,
  'shippedOrders',count(*) filter(where shipped)::int,
  'deliveredOrders',count(*) filter(where delivered)::int,
  'avgRating',(select avg_rating from reviews_agg),
  'reviewCount',(select review_count from reviews_agg),
  'returnCount',(select return_count from returns_agg),
  'disputeCount',(select dispute_count from disputes_agg)
) from scope;
$$;

comment on table return_requests is 'Customer return lifecycle. Refund execution remains provider-managed through provider_refund_requests.';
comment on function merchant_performance_snapshot(text) is 'Neutral merchant service metrics for the last 90 days; not a credit decision or customer-facing score.';
