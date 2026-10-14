-- Enterprise catalog transient-failure recovery.
-- A temporary upstream outage must not permanently remove a connection from the
-- scheduler. Keep explicit paused/error states for operator decisions, but use
-- next_sync_at for automatic bounded retry of active connections.

alter table enterprise_catalog_connections
  add column if not exists next_sync_at timestamptz;

create index if not exists enterprise_catalog_connections_schedule_idx
  on enterprise_catalog_connections(status,next_sync_at,last_sync_started_at)
  where status='active';

update enterprise_catalog_connections
   set status='active',
       next_sync_at=coalesce(next_sync_at, now())
 where status='error'
   and last_sync_status='failed';

comment on column enterprise_catalog_connections.next_sync_at
is 'Earliest scheduler retry time after transient catalog sync failure. Explicit operator pause/error remains separate from automatic retry.';
