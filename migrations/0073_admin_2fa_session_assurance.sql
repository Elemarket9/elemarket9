-- Deep admin assurance: sessions created before mandatory administrator 2FA
-- must not remain privileged after 2FA is enabled.
alter table "user" add column if not exists "twoFactorEnabledAt" timestamptz;

create or replace function stamp_two_factor_enabled_at() returns trigger language plpgsql as $$
begin
  if coalesce(new."twoFactorEnabled", false) and not coalesce(old."twoFactorEnabled", false) then
    new."twoFactorEnabledAt" := now();
  elsif not coalesce(new."twoFactorEnabled", false) then
    new."twoFactorEnabledAt" := null;
  end if;
  return new;
end; $$;

drop trigger if exists user_two_factor_assurance_stamp on "user";
create trigger user_two_factor_assurance_stamp
before update of "twoFactorEnabled" on "user"
for each row execute function stamp_two_factor_enabled_at();

-- Existing enabled accounts are treated as having enabled 2FA at migration time;
-- this deliberately invalidates sessions created before this assurance boundary.
update "user" set "twoFactorEnabledAt"=coalesce("twoFactorEnabledAt", now()) where coalesce("twoFactorEnabled", false);
