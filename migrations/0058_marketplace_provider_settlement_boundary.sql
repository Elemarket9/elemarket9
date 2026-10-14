-- ELEMARKET marketplace boundary: settlement is handled by the external payment provider.
-- Keep legacy settlement columns for backward compatibility, but they are not required
-- and new merchant applications do not collect or persist bank/mobile-money credentials.

create or replace function validate_new_merchant_application_profile()
returns trigger language plpgsql as $$
begin
  if new.registration_number is null or length(trim(new.registration_number)) < 2 then
    raise exception 'business number is required';
  end if;
  if new.taxpayer_id_type is null or new.taxpayer_id_encrypted is null or length(trim(new.taxpayer_id_encrypted)) < 20 then
    raise exception 'taxpayer identification is required';
  end if;
  if new.business_type is null then
    raise exception 'business type is required';
  end if;
  if new.tax_registration_status is null then
    raise exception 'tax registration status is required';
  end if;
  new.compliance_updated_at := now();
  return new;
end;
$$;

comment on table merchant_payment_accounts is 'Opaque payment-provider merchant account references only; provider owns payment settlement.';
