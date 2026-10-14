-- Merchant onboarding compliance and settlement profile.
-- VAT status is intentionally optional; core business/tax/settlement fields are required
-- for newly submitted merchant applications. Existing applications remain readable.

alter table merchant_applications
  add column if not exists taxpayer_id_type text,
  add column if not exists taxpayer_id_encrypted text,
  add column if not exists taxpayer_id_last4 text,
  add column if not exists business_type text,
  add column if not exists tax_registration_status text,
  add column if not exists vat_registration_status text,
  add column if not exists settlement_method text,
  add column if not exists settlement_details_encrypted text,
  add column if not exists settlement_destination_last4 text,
  add column if not exists compliance_updated_at timestamptz;

alter table merchant_applications
  drop constraint if exists merchant_applications_taxpayer_id_type_check,
  drop constraint if exists merchant_applications_business_type_check,
  drop constraint if exists merchant_applications_tax_registration_status_check,
  drop constraint if exists merchant_applications_vat_registration_status_check,
  drop constraint if exists merchant_applications_settlement_method_check;

alter table merchant_applications
  add constraint merchant_applications_taxpayer_id_type_check
    check (taxpayer_id_type is null or taxpayer_id_type in ('tin','ghana_card_pin','other')),
  add constraint merchant_applications_business_type_check
    check (business_type is null or business_type in ('sole_proprietorship','partnership','limited_company','cooperative','other')),
  add constraint merchant_applications_tax_registration_status_check
    check (tax_registration_status is null or tax_registration_status in ('registered','pending','not_registered','not_applicable')),
  add constraint merchant_applications_vat_registration_status_check
    check (vat_registration_status is null or vat_registration_status in ('registered','pending','not_registered','not_applicable')),
  add constraint merchant_applications_settlement_method_check
    check (settlement_method is null or settlement_method in ('bank','mobile_money'));

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
  if new.settlement_method is null or new.settlement_details_encrypted is null then
    raise exception 'settlement details are required';
  end if;
  new.compliance_updated_at := now();
  return new;
end;
$$;

drop trigger if exists merchant_application_profile_validate on merchant_applications;
create trigger merchant_application_profile_validate
before insert on merchant_applications
for each row execute function validate_new_merchant_application_profile();

-- Existing applications can be progressively completed by an admin/customer workflow.
create index if not exists merchant_applications_compliance_status_idx
  on merchant_applications(status, compliance_updated_at desc);
