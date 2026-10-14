-- v1.95 repair: merchant access is membership-based, while the base user role
-- remains `customer` after merchant activation. The v1.94 actor guard must not
-- reject legitimate merchant members merely because their identity row is still
-- customer-role. Keep database-level tenant binding while accepting either
-- supported merchant-capable identity role.

create or replace function assert_merchant_actor(
  p_actor_user_id text,
  p_merchant_id text
) returns void language plpgsql as $$
declare
  v_role text;
begin
  if p_actor_user_id is null or length(trim(p_actor_user_id)) < 1 then
    raise exception 'merchant identity required';
  end if;
  if p_merchant_id is null or length(trim(p_merchant_id)) < 1 then
    raise exception 'merchant account required';
  end if;

  select role into v_role from "user" where id=p_actor_user_id;
  if v_role not in ('customer','merchant') then
    raise exception 'merchant-capable actor role not satisfied';
  end if;

  if not exists (
    select 1
      from merchant_accounts ma
     where ma.merchant_id=p_merchant_id
       and ma.user_id=p_actor_user_id
       and ma.status='active'
  ) then
    raise exception 'merchant actor is not an active member of this merchant account';
  end if;
end;
$$;

revoke all on function assert_merchant_actor(text,text) from public;
grant execute on function assert_merchant_actor(text,text) to current_user;

comment on function assert_merchant_actor(text,text) is
  'Defense-in-depth merchant actor binding: requires customer/merchant identity role plus active membership in the target merchant account.';
