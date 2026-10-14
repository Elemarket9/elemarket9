-- Durable upload-object cleanup retry state.
-- A failed remote deletion must remain retryable instead of becoming terminally expired.
alter table storage_upload_intents
  drop constraint if exists storage_upload_intents_status_check;

alter table storage_upload_intents
  add constraint storage_upload_intents_status_check
  check (status in ('authorized','verifying','verified','cleanup_pending','expired','rejected'));

create index if not exists storage_upload_intents_cleanup_idx
  on storage_upload_intents(created_at asc, id)
  where status in ('authorized','verifying','rejected','cleanup_pending');
