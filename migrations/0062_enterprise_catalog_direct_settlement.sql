-- Enterprise catalog + direct settlement boundary.
-- Enterprise merchants can expose their own catalogue API and settle directly
-- through the configured PSP/subaccount. ELEMARKET monitors the order/payment
-- but deliberately does not create marketplace escrow for these merchants.

alter table merchants
  add column if not exists settlement_model text not null default 'marketplace_escrow';

alter table merchants drop constraint if exists merchants_settlement_model_check;
alter table merchants add constraint merchants_settlement_model_check
  check (settlement_model in ('marketplace_escrow','enterprise_direct')) not valid;

alter table merchants
  add column if not exists catalog_source text not null default 'native';
alter table merchants drop constraint if exists merchants_catalog_source_check;
alter table merchants add constraint merchants_catalog_source_check
  check (catalog_source in ('native','enterprise_api')) not valid;

alter table products
  add column if not exists catalog_source text not null default 'native';
alter table products drop constraint if exists products_catalog_source_check;
alter table products add constraint products_catalog_source_check
  check (catalog_source in ('native','enterprise_api')) not valid;

alter table products
  add column if not exists external_product_id text;
alter table products
  add column if not exists external_sku text;
alter table products
  add column if not exists external_updated_at timestamptz;
alter table products
  add column if not exists catalog_synced_at timestamptz;

create unique index if not exists products_enterprise_external_id_uq
  on products(merchant_id,external_product_id)
  where external_product_id is not null;
create index if not exists products_catalog_source_idx
  on products(merchant_id,catalog_source);

create table if not exists enterprise_catalog_connections (
  id text primary key,
  merchant_id text not null unique references merchants(id) on delete cascade,
  endpoint_url text not null check (char_length(endpoint_url) between 12 and 2000),
  auth_type text not null default 'bearer' check (auth_type in ('none','bearer','api_key','basic')),
  credentials_encrypted text,
  response_path text not null default 'products' check (char_length(response_path) between 1 and 200),
  field_mapping jsonb not null,
  sync_mode text not null default 'upsert_only' check (sync_mode in ('upsert_only','snapshot')),
  webhook_enabled boolean not null default false,
  webhook_secret_encrypted text,
  status text not null default 'active' check (status in ('active','paused','error')),
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  last_sync_status text check (last_sync_status in ('success','partial','failed')),
  last_sync_error text,
  last_sync_count integer not null default 0 check (last_sync_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists enterprise_catalog_connections_status_idx
  on enterprise_catalog_connections(status,last_sync_completed_at);

create table if not exists enterprise_catalog_sync_runs (
  id text primary key,
  connection_id text not null references enterprise_catalog_connections(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete restrict,
  status text not null check (status in ('running','success','partial','failed')),
  source text not null check (source in ('manual','scheduled','webhook')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  received_count integer not null default 0 check (received_count >= 0),
  upserted_count integer not null default 0 check (upserted_count >= 0),
  deactivated_count integer not null default 0 check (deactivated_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  error_message text
);
create index if not exists enterprise_catalog_sync_runs_merchant_idx
  on enterprise_catalog_sync_runs(merchant_id,started_at desc);

create table if not exists enterprise_catalog_items (
  id text primary key,
  connection_id text not null references enterprise_catalog_connections(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  external_product_id text not null,
  external_sku text,
  payload_hash text not null,
  payload jsonb not null,
  last_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  unique(connection_id,external_product_id)
);
create index if not exists enterprise_catalog_items_merchant_idx
  on enterprise_catalog_items(merchant_id,last_seen_at desc);

-- Enterprise merchants cannot accidentally enter the marketplace escrow path.
create or replace function merchant_uses_marketplace_escrow(p_merchant_id text)
returns boolean language sql stable as $$
  select exists(
    select 1 from merchants
    where id=p_merchant_id and settlement_model='marketplace_escrow'
  );
$$;

-- Provider-held release requests are meaningful only for marketplace escrow
-- merchants. Enterprise-direct merchants are settled by the PSP/subaccount and
-- therefore have no ELEMARKET release-request balance.
create or replace function create_merchant_fund_release_request(
  p_merchant_id text,
  p_amount numeric,
  p_merchant_note text default '',
  p_idempotency_key text default null
) returns jsonb language plpgsql as $$
declare
  v_model text;
  v_existing record;
  v_merchant_status text;
  v_requestable numeric := 0;
  v_remaining numeric;
  v_request text := 'frq_'||replace(gen_random_uuid()::text,'-','');
  v_item record;
  v_assessment jsonb;
  v_risk_id text;
  v_risk_decision text;
  v_items integer := 0;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'invalid fund release amount'; end if;
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then raise exception 'merchant required'; end if;
  if p_amount > 100000000 then raise exception 'fund release amount too large'; end if;
  if p_idempotency_key is not null and (length(trim(p_idempotency_key)) < 16 or length(trim(p_idempotency_key)) > 128) then
    raise exception 'invalid fund release idempotency key';
  end if;

  select status,settlement_model into v_merchant_status,v_model
    from merchants where id=p_merchant_id for update;
  if not found then raise exception 'merchant not found'; end if;
  if v_merchant_status <> 'active' then raise exception 'merchant is not active'; end if;
  if v_model <> 'marketplace_escrow' then
    raise exception 'enterprise-direct merchants do not use ELEMARKET escrow release requests';
  end if;

  if p_idempotency_key is not null then
    select id,status,amount,risk_decision into v_existing
      from merchant_fund_release_requests
     where merchant_id=p_merchant_id and idempotency_key=trim(p_idempotency_key)
     limit 1;
    if found then
      return jsonb_build_object('requestId',v_existing.id,'status',v_existing.status,'amount',v_existing.amount,'riskDecision',v_existing.risk_decision,'duplicate',true);
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('elemarket:fund-release:'||p_merchant_id));
  select provider_requestable_amount into v_requestable
    from merchant_provider_funds_summary where merchant_id=p_merchant_id;
  v_requestable := coalesce(v_requestable,0);
  if p_amount > v_requestable then
    raise exception 'requested amount exceeds provider-held amount eligible for release request';
  end if;

  v_assessment := evaluate_merchant_withdrawal_risk(p_merchant_id,p_amount);
  v_risk_id := nullif(v_assessment->>'assessmentId','');
  v_risk_decision := v_assessment->>'decision';

  insert into merchant_fund_release_requests(
    id,merchant_id,amount,status,risk_assessment_id,risk_decision,merchant_note,idempotency_key,created_at,updated_at
  ) values(
    v_request,p_merchant_id,p_amount,'pending_verification',v_risk_id,v_risk_decision,
    left(trim(coalesce(p_merchant_note,'')),2000),nullif(trim(p_idempotency_key),''),now(),now()
  );

  v_remaining := p_amount;
  for v_item in
    select e.id escrow_id,
           greatest(e.merchant_entitlement-coalesce(r.reserved_amount,0),0)::numeric(12,2) available_amount
      from escrows e
      left join (
        select i.escrow_id,sum(i.amount)::numeric(12,2) reserved_amount
        from merchant_fund_release_request_items i
        join merchant_fund_release_requests rr on rr.id=i.request_id
        where rr.status in ('pending_verification','approved_for_provider','submitted_to_provider','provider_confirmed')
        group by i.escrow_id
      ) r on r.escrow_id=e.id
     where e.merchant_id=p_merchant_id
       and (e.state='released' or (e.state='release_pending' and e.release_eligible_at is not null and e.release_eligible_at<=now()))
       and greatest(e.merchant_entitlement-coalesce(r.reserved_amount,0),0)>0
     order by coalesce(e.released_at,e.release_eligible_at,e.updated_at),e.id
     for update of e
  loop
    exit when v_remaining <= 0;
    insert into merchant_fund_release_request_items(id,request_id,escrow_id,amount)
    values('frqi_'||replace(gen_random_uuid()::text,'-',''),v_request,v_item.escrow_id,least(v_remaining,v_item.available_amount));
    v_remaining := v_remaining-least(v_remaining,v_item.available_amount);
  end loop;

  if v_remaining > 0.005 then raise exception 'unable to reserve eligible provider-held funds'; end if;

  perform record_audit_event(
    'merchant.fund_release.requested','merchant_fund_release_request',v_request,p_merchant_id,'merchant',null,'success',
    jsonb_build_object('amount',p_amount,'riskDecision',v_risk_decision,'custodyBoundary','external_provider','settlementModel','marketplace_escrow')
  );
  return jsonb_build_object('requestId',v_request,'status','pending_verification','riskDecision',v_risk_decision,'riskScore',coalesce((v_assessment->>'score')::integer,0),'duplicate',false);
end;
$$;

-- Payment completion creates escrow only for marketplace merchants. Enterprise
-- orders remain fully visible through payments/orders, but have no escrow row.
create or replace function create_escrow_for_completed_payment()
returns trigger language plpgsql as $$
declare
  v_order record;
  v_escrow text;
begin
  if new.status <> 'completed' or old.status = 'completed' then return new; end if;

  select o.id,o.merchant_id,o.product_total,o.delivery_total,o.platform_fee,o.merchant_net,o.grand_total,
         m.settlement_model
    into v_order
    from orders o
    join merchants m on m.id=o.merchant_id
   where o.id=new.order_id
   for update of o;
  if not found then raise exception 'payment order not found'; end if;
  if round(new.amount,2) <> round(v_order.grand_total,2) then
    raise exception 'payment/order amount mismatch';
  end if;

  if v_order.settlement_model='enterprise_direct' then
    perform record_audit_event(
      'payment.enterprise_direct.completed','order',v_order.id,null,'system',null,'success',
      jsonb_build_object('paymentId',new.id,'providerKey',new.provider_key,'providerReference',new.provider_reference,'escrowCreated',false,'settlementModel','enterprise_direct')
    );
    return new;
  end if;

  v_escrow := 'esc_' || replace(gen_random_uuid()::text,'-','');
  insert into escrows(
    id,order_id,payment_id,merchant_id,gross_amount,delivery_amount,
    platform_fee,merchant_entitlement,state,funded_at,created_at,updated_at
  ) values(
    v_escrow,v_order.id,new.id,v_order.merchant_id,v_order.grand_total,
    v_order.delivery_total,v_order.platform_fee,v_order.merchant_net,
    'held',now(),now(),now()
  ) on conflict(order_id) do nothing;

  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  select e.id,'funded','credit',e.gross_amount,new.id,
         jsonb_build_object('paymentId',new.id,'providerKey',new.provider_key,'providerConfirmed',true,'custodyBoundary','external_provider')
    from escrows e where e.order_id=v_order.id
  on conflict do nothing;

  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  select e.id,'fee_reserved','debit',e.platform_fee,new.id,
         jsonb_build_object('source','provider_payment_completion')
    from escrows e where e.order_id=v_order.id and e.platform_fee > 0
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists payment_completed_escrow_create on payments;
create trigger payment_completed_escrow_create
after update of status on payments
for each row execute function create_escrow_for_completed_payment();

-- Backfill guard: an enterprise merchant must never have an escrow created by
-- older code. Existing enterprise rows are left untouched rather than guessed;
-- administrators can reconcile them explicitly if the deployment had legacy data.
comment on column merchants.settlement_model is 'marketplace_escrow uses ELEMARKET escrow controls; enterprise_direct settles directly via the external PSP/subaccount and is excluded from ELEMARKET escrow.';
comment on column merchants.catalog_source is 'native means ELEMARKET catalogue; enterprise_api means the merchant is the source of truth.';
comment on table enterprise_catalog_connections is 'Server-side connection to an enterprise merchant catalogue API. Credentials are encrypted and never exposed to clients.';

-- Enterprise mode is an explicit admin-controlled operating mode. Enabling it
-- also switches the catalogue source so the merchant becomes the source of truth.
create or replace function admin_set_merchant_enterprise_mode(
  p_merchant_id text,
  p_admin_id text,
  p_enabled boolean,
  p_reason text
) returns jsonb language plpgsql as $$
declare
  v_old record;
  v_new_model text;
  v_new_tier text;
  v_new_catalog text;
begin
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then raise exception 'admin identity required'; end if;
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required'; end if;
  perform pg_advisory_xact_lock(hashtext('elemarket:merchant-mode:'||p_merchant_id));
  select id,tier,settlement_model,catalog_source,status into v_old from merchants where id=p_merchant_id for update;
  if not found then raise exception 'merchant not found'; end if;
  if p_enabled and v_old.status <> 'active' then raise exception 'merchant must be active before enterprise mode can be enabled'; end if;
  v_new_model := case when p_enabled then 'enterprise_direct' else 'marketplace_escrow' end;
  v_new_tier := case when p_enabled then 'enterprise' else 'merchant' end;
  v_new_catalog := case when p_enabled then 'enterprise_api' else 'native' end;
  update merchants set tier=v_new_tier,settlement_model=v_new_model,catalog_source=v_new_catalog where id=p_merchant_id;
  perform record_audit_event(
    case when p_enabled then 'admin.merchant.enterprise_enabled' else 'admin.merchant.enterprise_disabled' end,
    'merchant',p_merchant_id,p_admin_id,'admin',null,'success',
    jsonb_build_object('reason',left(trim(p_reason),2000),'previousTier',v_old.tier,'previousSettlementModel',v_old.settlement_model,'previousCatalogSource',v_old.catalog_source,'newTier',v_new_tier,'newSettlementModel',v_new_model,'newCatalogSource',v_new_catalog)
  );
  return jsonb_build_object('merchantId',p_merchant_id,'enterprise',p_enabled,'settlementModel',v_new_model,'catalogSource',v_new_catalog);
end;
$$;
comment on function admin_set_merchant_enterprise_mode(text,text,boolean,text) is 'Admin-only operating-mode switch. Enterprise mode uses external catalog API and direct PSP settlement; marketplace escrow remains disabled for enterprise orders.';
