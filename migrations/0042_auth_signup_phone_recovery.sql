-- Authentication account-contact hardening.
-- Phone ownership lives in the marketplace profile and is verified by the
-- existing provider-neutral OTP service. Password reset remains Better Auth's
-- signed-token flow; no reset secrets are stored by ELEMARKET.
alter table if exists profiles
  add column if not exists phone_verified_at timestamptz;

alter table if exists otp_challenges
  add column if not exists user_id text;

create index if not exists otp_challenges_user_purpose_idx
  on otp_challenges(user_id, purpose, created_at desc)
  where user_id is not null;
