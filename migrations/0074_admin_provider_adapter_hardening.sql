-- Admin/provider deep hardening.
-- Fixes the latest provider-boundary regression where the enterprise-mode
-- function signature no longer carried the authenticated admin identity.
-- The application always authorizes the caller first; this migration also
-- keeps the database audit record bound to that caller for defense in depth.
-- Drop the previous four-text/bool/text signature first. This makes the
-- migration safe even if a database was created by an earlier pre-fix 0070.
drop function if exists admin_set_merchant_enterprise_mode(text,text,boolean,text);

create function admin_set_merchant_enterprise_mode(
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
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then
    raise exception 'merchant required';
  end if;
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then
    raise exception 'admin identity required';
  end if;
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'reason required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:merchant-mode:'||p_merchant_id, 0));
  select id,tier,settlement_model,catalog_source,status
    into v_old
    from merchants
   where id=p_merchant_id
   for update;
  if not found then raise exception 'merchant not found'; end if;
  if p_enabled and v_old.status <> 'active' then
    raise exception 'merchant must be active before enterprise mode can be enabled';
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

  perform record_audit_event(
    case when p_enabled then 'admin.merchant.enterprise_enabled' else 'admin.merchant.enterprise_disabled' end,
    'merchant',
    p_merchant_id,
    p_admin_id,
    'admin',
    null,
    'success',
    jsonb_build_object(
      'reason',left(trim(p_reason),2000),
      'previousTier',v_old.tier,
      'previousSettlementModel',v_old.settlement_model,
      'previousCatalogSource',v_old.catalog_source,
      'newTier',v_new_tier,
      'newSettlementModel',v_new_model,
      'newCatalogSource',v_new_catalog
    )
  );

  return jsonb_build_object(
    'merchantId',p_merchant_id,
    'enterprise',p_enabled,
    'settlementModel',v_new_model,
    'catalogSource',v_new_catalog
  );
end;
$$;

comment on function admin_set_merchant_enterprise_mode(text,text,boolean,text)
is 'Admin-authorized operating-mode switch. Caller identity is retained for audit; external provider settlement remains authoritative.';
