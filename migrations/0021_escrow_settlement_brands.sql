-- ELEMARKET commerce financial controls and brand verification.
-- Escrow is an internal ledger/state machine. It does NOT imply ELEMARKET holds
-- customer funds; actual safeguarding/settlement remains with the licensed
-- payment/safeguarding provider.

create table if not exists brands (
  id text primary key,
  name text not null unique check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  status text not null default 'active' check (status in ('active','suspended')),
  verification_status text not null default 'unverified' check (verification_status in ('unverified','pending','verified')),
  official_brand boolean not null default false,
  website text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists merchant_brand_authorizations (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  relationship text not null check (relationship in ('seller','authorized_retailer','authorized_distributor','franchise','official_store')),
  status text not null default 'pending' check (status in ('pending','verified','rejected','expired')),
  evidence_ref text,
  reviewed_by text,
  reviewed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (merchant_id, brand_id, relationship)
);
create index if not exists merchant_brand_auth_merchant_idx on merchant_brand_authorizations(merchant_id,status);
create index if not exists merchant_brand_auth_brand_idx on merchant_brand_authorizations(brand_id,status);

alter table products add column if not exists brand_id text references brands(id);
create index if not exists products_brand_id_idx on products(brand_id);

create table if not exists escrows (
  id text primary key,
  order_id text not null unique references orders(id) on delete restrict,
  payment_id text not null unique references payments(id) on delete restrict,
  merchant_id text not null references merchants(id) on delete restrict,
  currency char(3) not null default 'GHS' check (currency='GHS'),
  gross_amount numeric(12,2) not null check (gross_amount > 0),
  delivery_amount numeric(12,2) not null default 0 check (delivery_amount >= 0),
  platform_fee numeric(12,2) not null default 0 check (platform_fee >= 0),
  merchant_entitlement numeric(12,2) not null check (merchant_entitlement >= 0),
  state text not null check (state in ('funding_pending','funded','held','fulfilling','delivered','release_pending','released','settled','disputed','refunded','cancelled')),
  funded_at timestamptz,
  delivered_at timestamptz,
  release_eligible_at timestamptz,
  released_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint escrow_amounts_valid check (gross_amount = merchant_entitlement + platform_fee + delivery_amount)
);
create index if not exists escrows_merchant_state_idx on escrows(merchant_id,state,updated_at desc);
create index if not exists escrows_release_idx on escrows(state,release_eligible_at) where state='release_pending';

create table if not exists escrow_ledger_entries (
  id bigserial primary key,
  escrow_id text not null references escrows(id) on delete restrict,
  entry_type text not null check (entry_type in ('funded','fee_reserved','delivery_reserved','release','refund','dispute_hold','adjustment')),
  direction text not null check (direction in ('credit','debit')),
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'GHS' check (currency='GHS'),
  reference text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (escrow_id, entry_type, reference)
);
create index if not exists escrow_ledger_escrow_idx on escrow_ledger_entries(escrow_id,created_at);

create table if not exists merchant_settlements (
  id text primary key,
  escrow_id text not null references escrows(id) on delete restrict,
  merchant_id text not null references merchants(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  currency char(3) not null default 'GHS' check (currency='GHS'),
  status text not null default 'eligible' check (status in ('eligible','processing','paid','failed','reversed')),
  provider_reference text,
  payout_destination_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (escrow_id)
);
create index if not exists merchant_settlements_merchant_idx on merchant_settlements(merchant_id,status,created_at desc);

create table if not exists escrow_disputes (
  id text primary key,
  escrow_id text not null references escrows(id) on delete restrict,
  opened_by text not null,
  reason text not null check (char_length(reason) between 8 and 2000),
  status text not null default 'open' check (status in ('open','under_review','resolved_release','resolved_refund','closed')),
  resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists escrow_disputes_escrow_idx on escrow_disputes(escrow_id,status);

create table if not exists merchant_payout_accounts (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  rail text not null check (rail in ('mobile_money','bank')),
  destination_ref text not null,
  status text not null default 'pending' check (status in ('pending','verified','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(merchant_id,rail,destination_ref)
);

-- Canonical catalogue brands. These are NOT marked as official/authorized
-- relationships; those require a separate verification workflow.
insert into brands(id,name,slug,verification_status,official_brand,website)
values
 ('brand_samsung','Samsung','samsung','unverified',false,'https://www.samsung.com/'),
 ('brand_hisense','Hisense','hisense','unverified',false,'https://www.hisense.com/')
on conflict (slug) do nothing;

-- Backfill existing brand text into canonical brand ids where unambiguous.
update products p set brand_id=b.id
from brands b
where lower(trim(p.brand)) = lower(b.name) and p.brand_id is null;

-- Payment completion creates the escrow record exactly once. This records an
-- entitlement, not custody of funds. The provider remains the settlement rail.
create or replace function create_escrow_for_completed_payment()
returns trigger language plpgsql as $$
declare
  v_order record;
  v_escrow text;
begin
  if new.status <> 'completed' or old.status = 'completed' then return new; end if;
  select id, merchant_id, product_total, delivery_total, platform_fee, merchant_net, grand_total
    into v_order from orders where id=new.order_id for update;
  if not found then raise exception 'escrow order not found'; end if;
  if new.amount <> v_order.grand_total then raise exception 'escrow payment/order amount mismatch'; end if;

  v_escrow := 'esc_' || replace(gen_random_uuid()::text,'-','');
  insert into escrows(id,order_id,payment_id,merchant_id,gross_amount,delivery_amount,platform_fee,merchant_entitlement,state,funded_at,created_at,updated_at)
  values(v_escrow,v_order.id,new.id,v_order.merchant_id,v_order.grand_total,v_order.delivery_total,v_order.platform_fee,v_order.merchant_net,'held',now(),now(),now())
  on conflict(order_id) do nothing;

  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  select e.id,'funded','credit',e.gross_amount,new.id,jsonb_build_object('paymentId',new.id,'providerKey',new.provider_key)
  from escrows e where e.order_id=v_order.id
  on conflict do nothing;

  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  select e.id,'fee_reserved','debit',e.platform_fee,new.id,jsonb_build_object('orderId',v_order.id)
  from escrows e where e.order_id=v_order.id and e.platform_fee > 0
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists payment_completed_escrow_create on payments;
create trigger payment_completed_escrow_create
after update of status on payments
for each row execute function create_escrow_for_completed_payment();

-- Merchant financial view: only amounts that are actually represented by
-- escrow/settlement records are reported as held/available.
create or replace view merchant_financial_summary as
select m.id merchant_id,
       m.name merchant_name,
       coalesce(sum(case when e.state in ('held','fulfilling','delivered','release_pending','disputed','refund_pending') then e.merchant_entitlement else 0 end),0)::numeric(12,2) as held_amount,
       coalesce(sum(case when s.status='eligible' then s.amount else 0 end),0)::numeric(12,2) as available_amount,
       coalesce(sum(case when s.status='processing' then s.amount else 0 end),0)::numeric(12,2) as payout_processing,
       coalesce(sum(case when s.status='paid' then s.amount else 0 end),0)::numeric(12,2) as paid_out
from merchants m
left join escrows e on e.merchant_id=m.id
left join merchant_settlements s on s.escrow_id=e.id
 group by m.id,m.name;

-- Explicitly release only an eligible escrow. This is an entitlement transition;
-- an external licensed settlement provider must execute the actual payout.
create or replace function release_escrow(p_escrow_id text, p_reference text)
returns jsonb language plpgsql as $$
declare v_e record; v_settlement text;
begin
  perform pg_advisory_xact_lock(hashtext('elemarket:escrow:'||p_escrow_id));
  select * into v_e from escrows where id=p_escrow_id for update;
  if not found then raise exception 'escrow not found'; end if;
  if v_e.state <> 'release_pending' then raise exception 'escrow is not release eligible'; end if;
  if v_e.release_eligible_at is null or v_e.release_eligible_at > now() then raise exception 'buyer protection window is still active'; end if;
  if exists(select 1 from escrow_disputes where escrow_id=v_e.id and status in ('open','under_review')) then raise exception 'escrow is disputed'; end if;
  update escrows set state='released', released_at=now(), updated_at=now() where id=v_e.id;
  v_settlement := 'set_'||replace(gen_random_uuid()::text,'-','');
  insert into merchant_settlements(id,escrow_id,merchant_id,amount,status) values(v_settlement,v_e.id,v_e.merchant_id,v_e.merchant_entitlement,'eligible') on conflict(escrow_id) do nothing;
  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  values(v_e.id,'release','debit',v_e.merchant_entitlement,p_reference,jsonb_build_object('settlementId',v_settlement)) on conflict do nothing;
  return jsonb_build_object('escrowId',v_e.id,'settlementId',v_settlement,'amount',v_e.merchant_entitlement,'status','eligible');
end;
$$;

-- Delivered orders become release-pending with a 48h buyer-protection window.
create or replace function mark_escrow_release_pending(p_order_id text)
returns jsonb language plpgsql as $$
declare v_e record;
begin
  select * into v_e from escrows where order_id=p_order_id for update;
  if not found then raise exception 'escrow not found'; end if;
  if v_e.state not in ('held','fulfilling','delivered') then raise exception 'escrow cannot enter release window'; end if;
  update escrows set state='release_pending', delivered_at=coalesce(delivered_at,now()), release_eligible_at=now()+interval '48 hours', updated_at=now() where id=v_e.id;
  return jsonb_build_object('escrowId',v_e.id,'state','release_pending','releaseEligibleAt',now()+interval '48 hours');
end;
$$;


create or replace function open_escrow_dispute(p_escrow_id text, p_user_id text, p_reason text)
returns jsonb language plpgsql as $$
declare v_e record; v_dispute text;
begin
  perform pg_advisory_xact_lock(hashtext('elemarket:escrow:'||p_escrow_id));
  select * into v_e from escrows where id=p_escrow_id for update;
  if not found then raise exception 'escrow not found'; end if;
  if not exists(select 1 from orders o where o.id=v_e.order_id and o.user_id=p_user_id) then raise exception 'dispute access denied'; end if;
  if v_e.state not in ('held','fulfilling','delivered','release_pending') then raise exception 'escrow cannot be disputed'; end if;
  if exists(select 1 from escrow_disputes where escrow_id=v_e.id and status in ('open','under_review')) then raise exception 'active dispute already exists'; end if;
  v_dispute := 'dsp_'||replace(gen_random_uuid()::text,'-','');
  insert into escrow_disputes(id,escrow_id,opened_by,reason,status) values(v_dispute,v_e.id,p_user_id,trim(p_reason),'open');
  update escrows set state='disputed',updated_at=now() where id=v_e.id;
  insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
  values(v_e.id,'dispute_hold','debit',v_e.merchant_entitlement,v_dispute,jsonb_build_object('openedBy',p_user_id)) on conflict do nothing;
  return jsonb_build_object('disputeId',v_dispute,'escrowId',v_e.id,'status','open');
end;
$$;

create or replace function resolve_escrow_dispute(p_dispute_id text, p_resolution text, p_admin_id text, p_note text default '')
returns jsonb language plpgsql as $$
declare v_d record; v_e record;
begin
  if p_resolution not in ('release','refund') then raise exception 'invalid dispute resolution'; end if;
  perform pg_advisory_xact_lock(hashtext('elemarket:dispute:'||p_dispute_id));
  select * into v_d from escrow_disputes where id=p_dispute_id for update;
  if not found then raise exception 'dispute not found'; end if;
  if v_d.status not in ('open','under_review') then raise exception 'dispute already resolved'; end if;
  select * into v_e from escrows where id=v_d.escrow_id for update;
  if p_resolution='release' then
    update escrow_disputes set status='resolved_release',resolution_note=p_note,resolved_by=p_admin_id,resolved_at=now() where id=v_d.id;
    update escrows set state='released',released_at=now(),updated_at=now() where id=v_e.id;
    insert into merchant_settlements(id,escrow_id,merchant_id,amount,status) values('set_'||replace(gen_random_uuid()::text,'-',''),v_e.id,v_e.merchant_id,v_e.merchant_entitlement,'eligible') on conflict(escrow_id) do nothing;
    insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata) values(v_e.id,'release','debit',v_e.merchant_entitlement,p_dispute,jsonb_build_object('resolution','release','adminId',p_admin_id)) on conflict do nothing;
  else
    update escrow_disputes set status='resolved_refund',resolution_note=p_note,resolved_by=p_admin_id,resolved_at=now() where id=v_d.id;
    update escrows set state='refunded',updated_at=now() where id=v_e.id;
    insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata) values(v_e.id,'refund','debit',v_e.gross_amount,p_dispute,jsonb_build_object('resolution','refund','adminId',p_admin_id)) on conflict do nothing;
    update orders set status='refunded',updated_at=now() where id=v_e.order_id and status <> 'refunded';
  end if;
  return jsonb_build_object('disputeId',v_d.id,'escrowId',v_e.id,'resolution',p_resolution);
end;
$$;
