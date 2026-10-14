-- v1.63: merchant financing API idempotency and retry safety.
alter table merchant_financing_applications
  add column if not exists idempotency_key text;

alter table merchant_financing_applications
  drop constraint if exists merchant_financing_applications_idempotency_key_check;
alter table merchant_financing_applications
  add constraint merchant_financing_applications_idempotency_key_check
  check (idempotency_key is null or char_length(idempotency_key) between 16 and 128);

create unique index if not exists merchant_financing_idempotency_uq
  on merchant_financing_applications(merchant_id,idempotency_key)
  where idempotency_key is not null;

comment on column merchant_financing_applications.idempotency_key is
  'Client-supplied retry key bound to the authenticated merchant workspace; prevents duplicate financing applications.';
