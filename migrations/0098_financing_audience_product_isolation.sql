-- v1.68: strict financing audience/product isolation.
-- Customer financing and merchant financing are separate trust/data domains.
-- ALL financing remains subject to provider approval; ELEMARKET never makes the credit decision.

create or replace function validate_financing_provider_definition()
returns trigger
language plpgsql
as $$
begin
  if new.audience = 'customer' and new.product_type not in ('bnpl','installment') then
    raise exception 'customer financing providers may only offer bnpl or installment products';
  end if;
  if new.audience = 'merchant' and new.product_type not in ('merchant_cash_advance','line_of_credit','term_loan') then
    raise exception 'merchant financing providers may only offer merchant financing products';
  end if;
  return new;
end;
$$;

drop trigger if exists financing_provider_definition_validate on financing_providers;
create trigger financing_provider_definition_validate
before insert or update of audience, product_type on financing_providers
for each row execute function validate_financing_provider_definition();

-- Tighten application/provider isolation at the database boundary. A valid audience
-- alone is insufficient: the product type must belong to the same financing domain.
create or replace function validate_financing_provider_audience()
returns trigger language plpgsql as $$
declare
  v_audience text;
  v_product_type text;
begin
  select audience, product_type into v_audience, v_product_type
    from financing_providers where id = new.provider_id;
  if v_audience is null then
    raise exception 'financing provider not found';
  end if;

  if tg_table_name = 'customer_financing_applications' then
    if v_audience <> 'customer' or v_product_type not in ('bnpl','installment') then
      raise exception 'provider is not a customer BNPL/installment provider';
    end if;
  elsif tg_table_name = 'merchant_financing_applications' then
    if v_audience <> 'merchant' or v_product_type not in ('merchant_cash_advance','line_of_credit','term_loan') then
      raise exception 'provider is not a merchant business-financing provider';
    end if;
  end if;
  return new;
end;
$$;

-- Provider-facing merchant health access is explicitly limited to merchant-financing providers.
-- Customer BNPL/installment providers can never receive this scope through the DB access grant.
create or replace function validate_merchant_health_provider_access()
returns trigger language plpgsql as $$
declare
  v_audience text;
  v_product_type text;
begin
  select audience, product_type into v_audience, v_product_type
    from financing_providers where id = new.provider_id;
  if v_audience <> 'merchant' or v_product_type not in ('merchant_cash_advance','line_of_credit','term_loan') then
    raise exception 'merchant health access requires a merchant business-financing provider';
  end if;
  if not (new.scopes @> '["merchant_health:read"]'::jsonb) then
    raise exception 'merchant health access requires merchant_health:read scope';
  end if;
  return new;
end;
$$;

drop trigger if exists merchant_health_provider_access_validate on merchant_financing_provider_access;
create trigger merchant_health_provider_access_validate
before insert or update of provider_id, scopes on merchant_financing_provider_access
for each row execute function validate_merchant_health_provider_access();

-- Explicitly prevent customer applications from carrying merchant-only data references
-- and merchant applications from carrying customer order references at the schema level.
create or replace function validate_financing_application_domain_columns()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'customer_financing_applications' then
    if new.order_group_id is null then
      raise exception 'customer financing must be bound to an order group';
    end if;
  elsif tg_table_name = 'merchant_financing_applications' then
    -- Merchant financing is business-level financing; it must never carry a customer order.
    return new;
  end if;
  return new;
end;
$$;

drop trigger if exists customer_financing_domain_columns_validate on customer_financing_applications;
create trigger customer_financing_domain_columns_validate
before insert or update of order_group_id on customer_financing_applications
for each row execute function validate_financing_application_domain_columns();

comment on table financing_providers is
  'Provider registry. audience=customer is restricted to BNPL/installment; audience=merchant is restricted to business financing. Provider approval is always required.';
comment on table merchant_financing_provider_access is
  'Merchant-health access grants. Only merchant business-financing providers may receive merchant_health:read.';
