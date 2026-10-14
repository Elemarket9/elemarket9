-- Enterprise catalog sync lease hardening.
-- A SELECT ... FOR UPDATE in one autocommit statement does not lock the row
-- across the subsequent network fetch and writes. Use a durable, expiring
-- ownership token instead so concurrent scheduled/manual/webhook syncs cannot
-- start the same merchant catalog twice.
alter table enterprise_catalog_connections
  add column if not exists sync_lock_token text,
  add column if not exists sync_lock_expires_at timestamptz;

create index if not exists enterprise_catalog_sync_lease_idx
  on enterprise_catalog_connections(sync_lock_expires_at)
  where sync_lock_token is not null;
