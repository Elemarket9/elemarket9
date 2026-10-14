-- Prevent duplicate external payment creation when concurrent requests observe the same open attempt.
alter table payment_attempts
  add column if not exists initiation_token text,
  add column if not exists initiation_expires_at timestamptz;

create index if not exists payment_attempts_initiation_claim_idx
  on payment_attempts(id, initiation_expires_at)
  where provider_reference is null;
