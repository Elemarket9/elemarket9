-- ELEMARKET-generated purpose-bound OTP, delivered by neutral SMS transport.
-- Authenticated rider receipt and challenge consumption share ONE database transaction.
create table delivery_otp_verifiers (
 challenge_id text primary key references otp_challenges(id),
 order_id text not null references orders(id),
 job_id text not null references delivery_jobs(id),
 rider_user_id text not null,
 mac_hex text not null check (mac_hex ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(),
 consumed_at timestamptz,
 unique(order_id,challenge_id)
);
create index delivery_otp_verifiers_job_idx on delivery_otp_verifiers(job_id,created_at desc);
-- New code-only challenges must never use the provider-side generate/verify service.
-- Rows from the pre-migration OTP service can be left to expire.
comment on table delivery_otp_verifiers is 'MAC of purpose-bound ELEMARKET six-digit handover OTP; secret is held in application KMS/env.';
