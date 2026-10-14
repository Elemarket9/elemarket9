-- v1.62: customer financing application abuse/idempotency hardening.
alter table customer_financing_applications
  add column if not exists idempotency_key text;

alter table customer_financing_applications
  drop constraint if exists customer_financing_applications_idempotency_key_check;
alter table customer_financing_applications
  add constraint customer_financing_applications_idempotency_key_check
  check (idempotency_key is null or char_length(idempotency_key) between 16 and 128);

create unique index if not exists customer_financing_idempotency_uq
  on customer_financing_applications(user_id,idempotency_key)
  where idempotency_key is not null;

create index if not exists customer_financing_active_user_idx
  on customer_financing_applications(user_id,created_at desc)
  where status in ('started','submitted','under_review','approved');

comment on column customer_financing_applications.idempotency_key is
  'Client-supplied retry key bound to the authenticated customer; prevents duplicate financing applications.';
