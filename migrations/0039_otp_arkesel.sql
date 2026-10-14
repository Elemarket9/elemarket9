-- ELEMARKET OTP lifecycle and provider-neutral challenge state.
-- Provider credentials and OTP values are never persisted.
create table if not exists otp_challenges (
  id text primary key,
  destination text not null,
  purpose text not null check (purpose in ('signup','login','phone_verification','password_reset','transactional')),
  provider text not null,
  status text not null check (status in ('sending','pending','verified','expired','locked','failed','superseded')),
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  cooldown_until timestamptz not null,
  provider_message text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists otp_challenges_destination_purpose_idx
  on otp_challenges(destination, purpose, created_at desc);

create index if not exists otp_challenges_expires_idx
  on otp_challenges(expires_at)
  where status = 'pending';

create unique index if not exists otp_challenges_one_pending_uq
  on otp_challenges(destination, purpose)
  where status = 'pending';
