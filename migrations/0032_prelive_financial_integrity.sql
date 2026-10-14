-- v1.54 pre-live financial integrity.
drop index if exists payment_attempts_one_open_per_payment_uq;

create unique index if not exists payment_attempts_payment_attempt_no_uq
  on payment_attempts(payment_id, attempt_no);

create unique index if not exists payment_attempts_provider_reference_uq
  on payment_attempts(provider_key, provider_reference)
  where provider_reference is not null;
