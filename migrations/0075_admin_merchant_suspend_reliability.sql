-- Admin merchant suspend/reinstate reliability hardening.
-- Supports seed/demo merchants that intentionally have no merchant_accounts row.
-- A reason is optional at the UI boundary; the database records a safe default.

create or replace function admin_set_merchant_status(
  p_merchant_id text,
  p_admin_id text,
  p_status text,
  p_reason text default null
) returns jsonb language plpgsql as $$
declare
  v_merchant record;
  v_reason text;
  v_action text;
begin
  if p_status not in ('active','suspended') then
    raise exception 'invalid merchant status';
  end if;
  if nullif(trim(p_admin_id),'') is null then
    raise exception 'admin identity required';
  end if;

  v_reason := coalesce(nullif(trim(p_reason),''),
    case when p_status='suspended' then 'Administrative merchant suspension' else 'Administrative merchant reinstatement' end);
  if char_length(v_reason) < 3 or char_length(v_reason) > 2000 then
    raise exception 'reason must be between 3 and 2000 characters';
  end if;

  -- FOR UPDATE makes repeated clicks/concurrent admin actions deterministic.
  select m.* into v_merchant
    from merchants m
   where m.id = p_merchant_id
   for update;
  if not found then
    raise exception 'merchant not found';
  end if;

  -- This deliberately does not require merchant_accounts. Seed/demo merchants
  -- are valid catalogue merchants without an owner account.
  update merchants
     set status = p_status
   where id = p_merchant_id;

  update merchant_accounts
     set status = case when p_status='active' then 'active' else 'suspended' end,
         updated_at = now()
   where merchant_id = p_merchant_id;

  v_action := case when p_status='active' then 'reinstate' else 'suspend' end;
  insert into admin_moderation_actions(target_type,target_id,action,reason,actor_user_id)
  values ('merchant',p_merchant_id,v_action,v_reason,p_admin_id);

  perform record_audit_event(
    'admin.merchant.' || case when p_status='active' then 'reinstated' else 'suspended' end,
    'merchant',p_merchant_id,p_admin_id,'admin',null,'success',
    jsonb_build_object('reason',v_reason,'previousStatus',v_merchant.status,'newStatus',p_status)
  );

  return jsonb_build_object(
    'merchantId',p_merchant_id,
    'status',p_status,
    'changed',v_merchant.status is distinct from p_status
  );
end;
$$;

comment on function admin_set_merchant_status(text,text,text,text) is
'Admin-only merchant enable/disable control. Works for seeded merchants without merchant_accounts and records an audit event.';
