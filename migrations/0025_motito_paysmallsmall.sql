-- Historical migration slot retained for migration ordering compatibility.
-- Financing configuration is provider-neutral. No provider is seeded or preferred here.

alter table financing_providers
  add column if not exists plan_mode text not null default 'provider_defined'
    check (plan_mode in ('provider_defined','layaway','credit')),
  add column if not exists minimum_initial_contribution_percent numeric(5,2) not null default 0
    check (minimum_initial_contribution_percent >= 0 and minimum_initial_contribution_percent <= 100),
  add column if not exists early_pickup_supported boolean not null default false,
  add column if not exists integration_mode text not null default 'api'
    check (integration_mode in ('api','partner_handoff','manual_review'));

create index if not exists financing_providers_customer_plan_idx
  on financing_providers(audience, product_type, plan_mode, status);

alter table customer_financing_applications
  add column if not exists initial_contribution_amount numeric(12,2),
  add column if not exists initial_contribution_percent numeric(5,2),
  add column if not exists remaining_amount numeric(12,2),
  add column if not exists plan_mode text;

alter table customer_financing_applications
  drop constraint if exists customer_financing_contribution_check;
alter table customer_financing_applications
  add constraint customer_financing_contribution_check check (
    (initial_contribution_amount is null and initial_contribution_percent is null and remaining_amount is null)
    or
    (initial_contribution_amount > 0 and initial_contribution_percent > 0 and initial_contribution_percent <= 100
      and remaining_amount >= 0 and abs((initial_contribution_amount + remaining_amount) - amount) < 0.01)
  );

create or replace function validate_customer_financing_contribution()
returns trigger language plpgsql as $$
declare v_min numeric(5,2); v_mode text;
begin
  select minimum_initial_contribution_percent, plan_mode into v_min, v_mode
    from financing_providers where id = new.provider_id and audience = 'customer' and status = 'active';
  if v_min is null then raise exception 'financing provider not found'; end if;
  if new.initial_contribution_amount is null then
    if v_min > 0 then raise exception 'initial contribution is required for this financing plan'; end if;
    return new;
  end if;
  if new.amount <= 0 then raise exception 'invalid financing amount'; end if;
  if new.initial_contribution_amount < round(new.amount * v_min / 100, 2) then raise exception 'initial contribution is below provider minimum'; end if;
  if new.initial_contribution_amount >= new.amount then raise exception 'initial contribution must be less than the order amount'; end if;
  new.initial_contribution_percent := round((new.initial_contribution_amount / new.amount) * 100, 2);
  new.remaining_amount := round(new.amount - new.initial_contribution_amount, 2);
  new.plan_mode := v_mode;
  return new;
end;
$$;

drop trigger if exists customer_financing_contribution_validate on customer_financing_applications;
create trigger customer_financing_contribution_validate
before insert or update of provider_id, amount, initial_contribution_amount
on customer_financing_applications for each row execute function validate_customer_financing_contribution();
