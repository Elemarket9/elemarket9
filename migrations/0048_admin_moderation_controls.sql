-- ELEMARKET admin moderation controls.
-- Administrative removal is a reversible operational suspension/revocation, not
-- destructive deletion. Financial/order/audit records are retained.

alter table "user"
  add column if not exists "moderationStatus" text not null default 'active';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_moderation_status_check'
  ) then
    alter table "user"
      add constraint user_moderation_status_check
      check ("moderationStatus" in ('active','blacklisted'));
  end if;
end $$;

create index if not exists user_moderation_status_idx
  on "user" ("moderationStatus", "createdAt" desc);

create table if not exists admin_moderation_actions (
  id bigserial primary key,
  target_type text not null check (target_type in ('merchant','customer','product')),
  target_id text not null,
  action text not null check (action in ('suspend','reinstate','blacklist','unblacklist','archive')),
  reason text not null check (char_length(trim(reason)) between 3 and 2000),
  actor_user_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_moderation_target_idx
  on admin_moderation_actions(target_type, target_id, created_at desc);

create or replace function admin_set_merchant_status(
  p_merchant_id text,
  p_admin_id text,
  p_status text,
  p_reason text
) returns jsonb language plpgsql as $$
declare v_merchant record; v_user_id text;
begin
  if p_status not in ('active','suspended') then raise exception 'invalid merchant status'; end if;
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required'; end if;
  select m.* into v_merchant from merchants m where m.id=p_merchant_id for update;
  if not found then raise exception 'merchant not found'; end if;

  update merchants set status=p_status where id=p_merchant_id;
  update merchant_accounts set status=case when p_status='active' then 'active' else 'suspended' end,
         updated_at=now() where merchant_id=p_merchant_id;
  insert into admin_moderation_actions(target_type,target_id,action,reason,actor_user_id)
  values ('merchant',p_merchant_id,case when p_status='active' then 'reinstate' else 'suspend' end,trim(p_reason),p_admin_id);

  perform record_audit_event(
    'admin.merchant.'||case when p_status='active' then 'reinstated' else 'suspended' end,
    'merchant',p_merchant_id,p_admin_id,'admin',null,'success',
    jsonb_build_object('reason',trim(p_reason),'previousStatus',v_merchant.status,'newStatus',p_status)
  );
  return jsonb_build_object('merchantId',p_merchant_id,'status',p_status);
end;
$$;

create or replace function admin_set_customer_blacklist(
  p_user_id text,
  p_admin_id text,
  p_blacklisted boolean,
  p_reason text
) returns jsonb language plpgsql as $$
declare v_role text; v_previous text;
begin
  if p_user_id=p_admin_id then raise exception 'admin cannot blacklist self'; end if;
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required'; end if;
  select role,"moderationStatus" into v_role,v_previous from "user" where id=p_user_id for update;
  if not found then raise exception 'customer not found'; end if;
  if v_role <> 'customer' then raise exception 'target is not a customer'; end if;

  update "user" set "moderationStatus"=case when p_blacklisted then 'blacklisted' else 'active' end,
    "updatedAt"=current_timestamp where id=p_user_id;

  if p_blacklisted then
    delete from "session" where "userId" = p_user_id;
  end if;

  insert into admin_moderation_actions(target_type,target_id,action,reason,actor_user_id)
  values ('customer',p_user_id,case when p_blacklisted then 'blacklist' else 'unblacklist' end,trim(p_reason),p_admin_id);

  perform record_audit_event(
    'admin.customer.'||case when p_blacklisted then 'blacklisted' else 'unblacklisted' end,
    'user',p_user_id,p_admin_id,'admin',null,'success',
    jsonb_build_object('reason',trim(p_reason),'previousStatus',v_previous)
  );
  return jsonb_build_object('userId',p_user_id,'moderationStatus',case when p_blacklisted then 'blacklisted' else 'active' end);
end;
$$;
