-- Resend email OTP support. OTP values are never persisted; only an HMAC digest is stored.
alter table otp_challenges add column if not exists code_hash text;
create index if not exists otp_challenges_resend_pending_idx
  on otp_challenges(destination, purpose, created_at desc)
  where provider='resend' and status='pending';

-- Prevent concurrent resend requests from creating multiple active challenges for the same destination/purpose.
create unique index if not exists otp_challenges_resend_one_active_uq
  on otp_challenges(destination, purpose)
  where provider='resend' and status in ('sending','pending');
