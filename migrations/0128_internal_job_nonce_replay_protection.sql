-- Replay-resistant internal worker authentication. Nonces are intentionally short-lived.
create table if not exists internal_job_nonces (
  nonce text primary key,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists internal_job_nonces_expires_idx on internal_job_nonces(expires_at);
