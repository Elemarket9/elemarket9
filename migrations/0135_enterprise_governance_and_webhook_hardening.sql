-- Enterprise lifecycle/RBAC/webhook hardening.
-- Keeps enterprise operations provider-neutral and non-custodial while ensuring
-- admin enablement provisions the organization boundary required by later
-- enterprise operating-system migrations.

alter table enterprise_webhook_events
  add column if not exists event_identity text;

update enterprise_webhook_events
   set event_identity = coalesce(nullif(trim(external_event_id),''), event_type || ':' || payload_hash)
 where event_identity is null;

alter table enterprise_webhook_events
  alter column event_identity set not null;

create unique index if not exists enterprise_webhook_event_identity_uq
  on enterprise_webhook_events(merchant_id,event_identity);

-- PostgreSQL unique constraints treat NULL values as distinct. Organization-wide
-- staff rows use location_id=NULL, so enforce uniqueness explicitly for them.
with ranked as (
  select ctid,row_number() over(partition by organization_id,user_id,role order by created_at,id) as rn
    from enterprise_location_staff
   where location_id is null
)
delete from enterprise_location_staff s using ranked r
 where s.ctid=r.ctid and r.rn>1;

create unique index if not exists enterprise_staff_orgwide_role_uq
  on enterprise_location_staff(organization_id,user_id,role)
  where location_id is null;

create or replace function admin_set_merchant_enterprise_mode(
  p_merchant_id text,
  p_admin_id text,
  p_enabled boolean,
  p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_old record;
  v_new_model text;
  v_new_tier text;
  v_new_catalog text;
  v_org_id text;
  v_owner_id text;
  v_admin_role text;
begin
  if current_setting('app.user_id',true) is distinct from p_admin_id then
    raise exception 'unauthorized';
  end if;
  select role into v_admin_role from "user" where id=p_admin_id;
  if v_admin_role <> 'admin' then raise exception 'admin role required'; end if;
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then raise exception 'merchant required'; end if;
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'reason required'; end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:merchant-mode:'||p_merchant_id, 0));
  select id,name,tier,settlement_model,catalog_source,status,verified
    into v_old
    from merchants
   where id=p_merchant_id
   for update;
  if not found then raise exception 'merchant not found'; end if;

  if p_enabled then
    if v_old.status <> 'active' then raise exception 'merchant must be active before enterprise mode can be enabled'; end if;
    if not v_old.verified then raise exception 'merchant must be verified before enterprise mode can be enabled'; end if;
    select user_id into v_owner_id
      from merchant_accounts
     where merchant_id=p_merchant_id and status='active'
     limit 1;
    if v_owner_id is null then raise exception 'enterprise merchant owner account is required'; end if;
  end if;

  v_new_model := case when p_enabled then 'enterprise_direct' else 'provider_direct' end;
  v_new_tier := case when p_enabled then 'enterprise' else 'merchant' end;
  v_new_catalog := case when p_enabled then 'enterprise_api' else 'native' end;

  update merchants
     set tier=v_new_tier,
         settlement_model=v_new_model,
         catalog_source=v_new_catalog,
         updated_at=now()
   where id=p_merchant_id;

  if p_enabled then
    insert into enterprise_organizations(id,merchant_id,legal_name,status,updated_at)
    values('ent_'||replace(gen_random_uuid()::text,'-',''),p_merchant_id,v_old.name,'active',now())
    on conflict(merchant_id) do update
      set legal_name=excluded.legal_name,status='active',updated_at=now()
    returning id into v_org_id;

    insert into enterprise_location_staff(id,organization_id,user_id,location_id,role,status,updated_at)
    values('est_'||replace(gen_random_uuid()::text,'-',''),v_org_id,v_owner_id,null,'enterprise_admin','active',now())
    on conflict(organization_id,user_id,role) where location_id is null
    do update set status='active',updated_at=now();
  else
    update enterprise_organizations
       set status='suspended',updated_at=now()
     where merchant_id=p_merchant_id and status<>'closed';

    -- Disabling enterprise mode must stop scheduled catalog ingestion. Keep the
    -- connection record and encrypted credentials so a later re-enable can be
    -- deliberately re-tested/re-activated by an enterprise administrator.
    update enterprise_catalog_connections
       set status='paused',sync_lock_token=null,sync_lock_expires_at=null,updated_at=now()
     where merchant_id=p_merchant_id and status<>'paused';
  end if;

  perform record_audit_event(
    case when p_enabled then 'admin.merchant.enterprise_enabled' else 'admin.merchant.enterprise_disabled' end,
    'merchant',p_merchant_id,p_admin_id,'admin',null,'success',
    jsonb_build_object(
      'reason',left(trim(p_reason),2000),
      'previousTier',v_old.tier,
      'previousSettlementModel',v_old.settlement_model,
      'previousCatalogSource',v_old.catalog_source,
      'newTier',v_new_tier,
      'newSettlementModel',v_new_model,
      'newCatalogSource',v_new_catalog,
      'enterpriseOrganizationId',v_org_id
    )
  );

  return jsonb_build_object(
    'merchantId',p_merchant_id,
    'enterprise',p_enabled,
    'settlementModel',v_new_model,
    'catalogSource',v_new_catalog,
    'enterpriseOrganizationId',v_org_id
  );
end;
$$;

revoke all on function admin_set_merchant_enterprise_mode(text,text,boolean,text) from public;

comment on function admin_set_merchant_enterprise_mode(text,text,boolean,text)
is 'Admin-only atomic enterprise lifecycle switch. Provisions organization/RBAC on enable and pauses enterprise catalog ingestion on disable; provider settlement remains external.';
