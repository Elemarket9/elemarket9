-- Durable per-intent cleanup claims prevent overlapping cron invocations from
-- deleting the same remote object concurrently. Expired claims are retryable.
alter table storage_upload_intents
  add column if not exists cleanup_claim_token text,
  add column if not exists cleanup_claim_expires_at timestamptz;

create index if not exists storage_upload_intents_cleanup_claim_idx
  on storage_upload_intents(cleanup_claim_expires_at, created_at, id)
  where status in ('authorized','verifying','rejected','cleanup_pending');
