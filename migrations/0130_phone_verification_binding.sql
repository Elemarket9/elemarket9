-- One canonical storage format; TS normalizeGhanaPhone is the application normalizer.
-- Convert only known legacy formats. Unique collisions fail the migration for operator repair.
update profiles set phone=case when phone ~ '^0[25][0-9]{8}$' then '+233'||substring(phone from 2)
  when phone ~ '^233[25][0-9]{8}$' then '+'||phone else phone end;
update merchant_applications set contact=case when contact ~ '^0[25][0-9]{8}$' then '+233'||substring(contact from 2)
  when contact ~ '^233[25][0-9]{8}$' then '+'||contact else contact end;
update otp_challenges set destination=case when destination ~ '^0[25][0-9]{8}$' then '+233'||substring(destination from 2)
  when destination ~ '^233[25][0-9]{8}$' then '+'||destination else destination end
where purpose='phone_verification';
-- Legacy verification may have been created through the vulnerable paths. Re-verify it.
update profiles set phone_verified_at=null where phone_verified_at is not null;
update merchant_verification_checks mvc set status='pending',reviewed_at=null,reviewed_by=null
from merchant_applications ma where mvc.application_id=ma.id and ma.status in ('pending','reviewing')
  and mvc.check_type='phone' and mvc.status='verified';
alter table otp_challenges add column phone_applied_at timestamptz;

create function invalidate_changed_profile_phone() returns trigger language plpgsql as $$
begin
  if new.phone is not null and new.phone !~ '^\+233[25][0-9]{8}$' then raise exception 'phone must use canonical Ghana format'; end if;
  if tg_op='INSERT' then
    new.phone_verified_at:=null;
  elsif new.phone is distinct from old.phone then
    new.phone_verified_at:=null;
    update merchant_verification_checks mvc set status='pending',reviewed_by=null,reviewed_at=null,updated_at=now()
    from merchant_applications ma where mvc.application_id=ma.id and ma.user_id=new.user_id and ma.status in ('pending','reviewing') and mvc.check_type='phone';
  end if;
  return new;
end; $$;
create trigger profiles_phone_invalidation before insert or update of phone on profiles
for each row execute function invalidate_changed_profile_phone();

create function invalidate_changed_application_contact() returns trigger language plpgsql as $$
begin
  if new.contact is distinct from old.contact then
    update merchant_verification_checks set status='pending',reviewed_at=null,reviewed_by=null,updated_at=now()
    where application_id=new.id and check_type='phone';
  end if;
  return new;
end; $$;
create trigger application_phone_invalidation before update of contact on merchant_applications
for each row execute function invalidate_changed_application_contact();

create function confirm_phone_verification(p_user text,p_challenge text) returns boolean language plpgsql as $$
declare v_profile record; v_challenge record; v_app record; v_count integer;
begin
  -- Serialize phone mutations and confirmation on the same profile row.
  select * into v_profile from profiles where user_id=p_user for update;
  if not found then raise exception 'profile not found'; end if;
  select * into v_challenge from otp_challenges where id=p_challenge for update;
  if not found or v_challenge.user_id is distinct from p_user or v_challenge.purpose<>'phone_verification'
     or v_challenge.status<>'verified' or v_challenge.verified_at is null or v_challenge.expires_at<=now()
     or v_challenge.phone_applied_at is not null or v_profile.phone is null
     or v_challenge.destination is distinct from v_profile.phone then
    raise exception 'phone verification does not match this account and contact';
  end if;
  update profiles set phone_verified_at=now(),updated_at=now() where user_id=p_user;
  update otp_challenges set phone_applied_at=now() where id=p_challenge;
  -- Profile-only verification remains supported before a merchant application is created.
  for v_app in select * from merchant_applications where user_id=p_user and status in ('pending','reviewing') for update loop
    if v_app.contact is distinct from v_challenge.destination then raise exception 'application contact does not match verified phone'; end if;
    update merchant_verification_checks set status='verified',reviewed_by=p_user,reviewed_at=now(),updated_at=now()
    where application_id=v_app.id and check_type='phone';
    get diagnostics v_count=row_count;
    if v_count<>1 then raise exception 'application phone check not found'; end if;
  end loop;
  return true;
end; $$;
revoke all on function confirm_phone_verification(text,text) from public;

-- Covers application creation and administrative/manual mutation paths as well.
create function enforce_merchant_phone_proof() returns trigger language plpgsql as $$
declare v_app record; v_profile record;
begin
  if new.check_type='phone' and new.status='verified' then
    select * into v_app from merchant_applications where id=new.application_id;
    select * into v_profile from profiles where user_id=v_app.user_id for update;
    if not found or v_profile.phone is distinct from v_app.contact or v_profile.phone_verified_at is null
       or not exists(select 1 from otp_challenges where user_id=v_app.user_id and purpose='phone_verification'
         and destination=v_app.contact and status='verified' and phone_applied_at>=v_profile.phone_verified_at) then
      raise exception 'merchant phone verification requires matching account OTP proof';
    end if;
  end if;
  return new;
end; $$;
create trigger merchant_phone_proof before insert or update of status on merchant_verification_checks
for each row execute function enforce_merchant_phone_proof();
