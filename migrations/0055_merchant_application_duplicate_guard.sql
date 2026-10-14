-- Merchant application anti-duplication guard.
-- The homepage is the only intended UI entry point for merchant registration,
-- but the server/database must enforce the same rule because URLs can be called directly.
-- Allow a user to reapply after a rejected/cancelled application, while preventing
-- concurrent duplicate pending/reviewing applications.

create or replace function prevent_duplicate_merchant_application()
returns trigger language plpgsql as $$
declare
  v_existing text;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('elemarket:merchant-application-user:' || new.user_id, 0)
  );

  select id into v_existing
    from merchant_applications
   where user_id = new.user_id
     and status in ('pending', 'reviewing')
   order by created_at desc
   limit 1;

  if v_existing is not null then
    raise exception 'merchant application already pending or under review';
  end if;

  return new;
end;
$$;

drop trigger if exists merchant_application_duplicate_guard on merchant_applications;
create trigger merchant_application_duplicate_guard
before insert on merchant_applications
for each row execute function prevent_duplicate_merchant_application();
