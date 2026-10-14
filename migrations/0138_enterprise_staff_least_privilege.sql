-- Enterprise staff least-privilege operations.
-- Enterprise staff access is separate from ordinary merchant ownership/finance access.

create or replace function assert_enterprise_org_role_access(
  p_user_id text,
  p_organization_id text,
  p_allowed_roles text[]
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if exists(
    select 1 from enterprise_location_staff s
     where s.organization_id=p_organization_id and s.user_id=p_user_id
       and s.status='active' and s.role='enterprise_admin'
  ) then return; end if;
  if exists(
    select 1 from enterprise_location_staff s
     where s.organization_id=p_organization_id and s.user_id=p_user_id
       and s.location_id is null and s.status='active' and s.role=any(p_allowed_roles)
  ) then return; end if;
  raise exception 'enterprise organization access denied';
end;
$$;
revoke all on function assert_enterprise_org_role_access(text,text,text[]) from public;

create or replace function assert_enterprise_location_role_access(
  p_user_id text,
  p_location_id text,
  p_allowed_roles text[]
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_org text;
begin
  select organization_id into v_org from merchant_inventory_locations where id=p_location_id and status='active';
  if v_org is null then raise exception 'location not found'; end if;
  if exists(
    select 1 from enterprise_location_staff s
     where s.organization_id=v_org and s.user_id=p_user_id and s.status='active'
       and s.role='enterprise_admin'
  ) then return; end if;
  if exists(
    select 1 from enterprise_location_staff s
     where s.organization_id=v_org and s.user_id=p_user_id and s.status='active'
       and s.role=any(p_allowed_roles) and (s.location_id=p_location_id or s.location_id is null)
  ) then return; end if;
  raise exception 'enterprise location role access denied';
end;
$$;
revoke all on function assert_enterprise_location_role_access(text,text,text[]) from public;

create or replace function manage_enterprise_staff_assignment(
  p_actor_id text,
  p_organization_id text,
  p_target_email text,
  p_location_id text,
  p_role text,
  p_status text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_target_id text;
  v_assignment_id text;
  v_allowed_roles constant text[] := array['enterprise_admin','operations_manager','location_manager','warehouse_operator','inventory_manager','fulfillment_operator','support_manager','analyst'];
begin
  if current_setting('app.user_id',true) is distinct from p_actor_id then raise exception 'unauthorized'; end if;
  perform assert_enterprise_admin_access(p_actor_id,p_organization_id);
  if p_role is null or not (p_role=any(v_allowed_roles)) then raise exception 'invalid enterprise role'; end if;
  if p_status not in ('active','suspended','revoked') then raise exception 'invalid staff status'; end if;

  select id into v_target_id from "user"
   where lower(email)=lower(trim(p_target_email))
     and "emailVerified"=true
     and coalesce("moderationStatus",'active')='active'
   limit 1;
  if v_target_id is null then raise exception 'verified active user not found'; end if;

  if p_location_id is not null and not exists(
    select 1 from merchant_inventory_locations where id=p_location_id and organization_id=p_organization_id
  ) then raise exception 'location does not belong to enterprise'; end if;

  if p_role='enterprise_admin' and p_location_id is not null then raise exception 'enterprise admin must be organization-wide'; end if;
  if p_role in ('location_manager','warehouse_operator','inventory_manager','fulfillment_operator') and p_location_id is null then
    raise exception 'location-scoped role requires a location';
  end if;

  if p_location_id is null then
    insert into enterprise_location_staff(id,organization_id,user_id,location_id,role,status,updated_at)
    values('est_'||replace(gen_random_uuid()::text,'-',''),p_organization_id,v_target_id,null,p_role,p_status,now())
    on conflict(organization_id,user_id,role) where location_id is null
    do update set status=excluded.status,updated_at=now()
    returning id into v_assignment_id;
  else
    insert into enterprise_location_staff(id,organization_id,user_id,location_id,role,status,updated_at)
    values('est_'||replace(gen_random_uuid()::text,'-',''),p_organization_id,v_target_id,p_location_id,p_role,p_status,now())
    on conflict(organization_id,user_id,location_id,role)
    do update set status=excluded.status,updated_at=now()
    returning id into v_assignment_id;
  end if;

  perform record_audit_event(
    'enterprise.staff.assignment_changed','enterprise_staff',v_assignment_id,p_actor_id,'merchant',null,'success',
    jsonb_build_object('organizationId',p_organization_id,'targetUserId',v_target_id,'locationId',p_location_id,'role',p_role,'status',p_status)
  );
  return jsonb_build_object('assignmentId',v_assignment_id,'userId',v_target_id,'role',p_role,'status',p_status,'locationId',p_location_id);
end;
$$;
revoke all on function manage_enterprise_staff_assignment(text,text,text,text,text,text) from public;
