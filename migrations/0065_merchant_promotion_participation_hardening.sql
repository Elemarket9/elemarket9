-- Merchant participation for platform-wide promotions.
-- A global promotion may require explicit merchant opt-in. Participation is
-- tenant-scoped, auditable, and enforced again at redemption time so the API
-- cannot bypass the merchant consent boundary.

alter table promotions
  add column if not exists participation_required boolean not null default false;

create table if not exists promotion_participations (
  id text primary key,
  promotion_id text not null references promotions(id) on delete cascade,
  merchant_id text not null references merchants(id) on delete cascade,
  status text not null default 'invited'
    check (status in ('invited','accepted','declined','withdrawn')),
  terms_version text not null default 'v1',
  terms_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(terms_snapshot)='object'),
  accepted_at timestamptz,
  declined_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (promotion_id, merchant_id)
);
create index if not exists promotion_participations_merchant_idx
  on promotion_participations(merchant_id,status,updated_at desc);
create index if not exists promotion_participations_promotion_idx
  on promotion_participations(promotion_id,status,updated_at desc);

-- A participation record is only meaningful for a platform/global promotion.
create or replace function validate_promotion_participation()
returns trigger language plpgsql as $$
declare
  p record;
  m record;
begin
  select merchant_id,status,starts_at,ends_at into p
    from promotions where id=new.promotion_id for update;
  if not found then raise exception 'promotion not found'; end if;
  if p.merchant_id is not null then
    raise exception 'merchant participation is only valid for platform promotions';
  end if;
  select status,verified into m from merchants where id=new.merchant_id;
  if not found or m.status<>'active' or m.verified is not true then
    raise exception 'merchant is not eligible for promotion participation';
  end if;
  if new.status='accepted' and p.status='archived' then
    raise exception 'promotion is archived';
  end if;
  if new.status='accepted' and p.ends_at<=now() then
    raise exception 'promotion has ended';
  end if;
  if new.status='accepted' and new.accepted_at is null then new.accepted_at:=now(); end if;
  if new.status='declined' and new.declined_at is null then new.declined_at:=now(); end if;
  if new.status='withdrawn' and new.withdrawn_at is null then new.withdrawn_at:=now(); end if;
  new.updated_at:=now();
  return new;
end;
$$;

drop trigger if exists promotion_participation_integrity on promotion_participations;
create trigger promotion_participation_integrity
before insert or update on promotion_participations
for each row execute function validate_promotion_participation();

-- A merchant can participate in a platform promotion only when the promotion
-- permits participation and the merchant has explicitly accepted it.
create or replace function assert_promotion_merchant_participation(
  p_promotion_id text,
  p_merchant_id text
) returns void language plpgsql as $$
declare
  p record;
begin
  select merchant_id,participation_required,status,starts_at,ends_at
    into p from promotions where id=p_promotion_id for update;
  if not found then raise exception 'promotion not found'; end if;
  if not exists (select 1 from merchants where id=p_merchant_id and status='active' and verified=true) then
    raise exception 'merchant is not currently eligible for promotion';
  end if;
  if p.merchant_id is not null then
    if p.merchant_id<>p_merchant_id then raise exception 'promotion is not valid for this merchant'; end if;
    return;
  end if;
  if p.participation_required and not exists (
    select 1 from promotion_participations pp
     where pp.promotion_id=p_promotion_id
       and pp.merchant_id=p_merchant_id
       and pp.status='accepted'
  ) then
    raise exception 'merchant has not accepted this promotion';
  end if;
end;
$$;

-- Redemption is the final security boundary. Even if application code is
-- changed or another checkout path is introduced, a required platform promo
-- cannot be redeemed for a merchant who did not opt in.
create or replace function enforce_promotion_redemption_participation()
returns trigger language plpgsql as $$
declare
  v_merchant text;
begin
  select merchant_id into v_merchant from orders where id=new.order_id;
  if v_merchant is null then raise exception 'promotion order merchant missing'; end if;
  perform assert_promotion_merchant_participation(new.promotion_id,v_merchant);
  return new;
end;
$$;

drop trigger if exists promotion_redemption_participation on promotion_redemptions;
create trigger promotion_redemption_participation
before insert or update of promotion_id,order_id on promotion_redemptions
for each row execute function enforce_promotion_redemption_participation();

create or replace function set_merchant_promotion_participation(
  p_promotion_id text,
  p_merchant_id text,
  p_accept boolean,
  p_user_id text
) returns jsonb language plpgsql as $$
declare
  p record;
  m record;
  v_id text;
  v_status text;
begin
  select * into p from promotions where id=p_promotion_id for update;
  if not found then raise exception 'promotion not found'; end if;
  if p.merchant_id is not null then raise exception 'merchant-owned promotions do not require participation'; end if;
  if p.status='archived' or p.ends_at<=now() then raise exception 'promotion is no longer available'; end if;
  select status,verified into m from merchants where id=p_merchant_id for update;
  if not found or m.status<>'active' or m.verified is not true then raise exception 'merchant is not eligible'; end if;

  v_status:=case when p_accept then 'accepted' else 'declined' end;
  v_id:='pp_'||replace(gen_random_uuid()::text,'-','');
  insert into promotion_participations(id,promotion_id,merchant_id,status,terms_version,terms_snapshot,accepted_at,declined_at,updated_at)
  values(v_id,p_promotion_id,p_merchant_id,v_status,'v1',jsonb_build_object(
    'discountType',p.discount_type,'discountValue',p.discount_value,'currency',p.currency,
    'minSubtotal',p.min_subtotal,'maxDiscount',p.max_discount,'usageLimit',p.usage_limit,
    'perCustomerLimit',p.per_customer_limit,'startsAt',p.starts_at,'endsAt',p.ends_at,
    'firstOrderOnly',p.first_order_only,'newCustomerOnly',p.new_customer_only
  ),case when p_accept then now() else null end,case when not p_accept then now() else null end,now())
  on conflict (promotion_id,merchant_id) do update set
    status=excluded.status,
    terms_version=excluded.terms_version,
    accepted_at=excluded.accepted_at,
    declined_at=excluded.declined_at,
    withdrawn_at=null,
    updated_at=now();

  perform record_audit_event(
    case when p_accept then 'merchant.promotion.accepted' else 'merchant.promotion.declined' end,
    'promotion',p_promotion_id,p_user_id,'merchant',null,'success',
    jsonb_build_object('merchantId',p_merchant_id,'termsVersion','v1')
  );

  return jsonb_build_object('promotionId',p_promotion_id,'merchantId',p_merchant_id,'status',v_status,'termsVersion','v1');
end;
$$;

create or replace function withdraw_merchant_promotion_participation(
  p_promotion_id text,
  p_merchant_id text,
  p_user_id text
) returns jsonb language plpgsql as $$
declare v_status text;
begin
  update promotion_participations
     set status='withdrawn',withdrawn_at=now(),updated_at=now()
   where promotion_id=p_promotion_id and merchant_id=p_merchant_id and status='accepted'
  returning status into v_status;
  if v_status is null then raise exception 'accepted promotion participation not found'; end if;
  perform record_audit_event('merchant.promotion.withdrawn','promotion',p_promotion_id,p_user_id,'merchant',null,'success',jsonb_build_object('merchantId',p_merchant_id));
  return jsonb_build_object('promotionId',p_promotion_id,'merchantId',p_merchant_id,'status','withdrawn');
end;
$$;
