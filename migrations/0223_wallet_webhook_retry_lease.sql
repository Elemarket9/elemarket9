-- A signed webhook must be retryable if processing fails after its inbox row
-- is persisted.  The lease serializes identical payloads without a long-lived
-- database transaction spanning a provider read-back.
alter table wallet_payout_events
  add column if not exists processing_token text,
  add column if not exists processing_until timestamptz;

comment on column wallet_payout_events.processing_until is
  'Expired processing leases may be reclaimed by verified webhook retries. processed_at alone means completed.';

create index if not exists wallet_payout_events_unprocessed_idx
  on wallet_payout_events(processing_until, received_at)
  where processed_at is null;
