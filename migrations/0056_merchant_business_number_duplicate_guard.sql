-- Prevent the same legal/business registration number from being used to create
-- multiple active merchant applications through separate customer identities.
-- Rejected applications remain reusable after a fresh review cycle.

create or replace function prevent_duplicate_merchant_business_number()
returns trigger language plpgsql as $$
declare
  v_existing text;
  v_number text;
begin
  v_number := lower(regexp_replace(trim(coalesce(new.registration_number, '')), '\\s+', '', 'g'));

  if v_number = '' then
    raise exception 'business number is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('elemarket:merchant-business-number:' || v_number, 0)
  );

  select id into v_existing
    from merchant_applications
   where lower(regexp_replace(trim(coalesce(registration_number, '')), '\\s+', '', 'g')) = v_number
     and status in ('pending', 'reviewing', 'approved')
     and id <> coalesce(new.id, '')
   order by created_at desc
   limit 1;

  if v_existing is not null then
    raise exception 'business number is already associated with an active merchant application';
  end if;

  return new;
end;
$$;

drop trigger if exists merchant_application_business_number_duplicate_guard on merchant_applications;
create trigger merchant_application_business_number_duplicate_guard
before insert or update of registration_number on merchant_applications
for each row execute function prevent_duplicate_merchant_business_number();
