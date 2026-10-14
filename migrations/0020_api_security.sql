-- ELEMARKET v1.41.0 API security hardening.
-- Durable, database-backed fixed-window rate limiting for public/server APIs.
-- The key is a SHA-256 digest so raw client addresses are never persisted.

create table if not exists api_rate_limit_buckets (
  bucket_key text primary key,
  window_start timestamptz not null,
  request_count integer not null check (request_count >= 0),
  expires_at timestamptz not null
);

create index if not exists api_rate_limit_buckets_expiry_idx
  on api_rate_limit_buckets(expires_at);

create or replace function consume_api_rate_limit(
  p_bucket_key text,
  p_window_seconds integer,
  p_max_requests integer
) returns jsonb
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row api_rate_limit_buckets%rowtype;
  v_window_start timestamptz;
  v_allowed boolean;
  v_remaining integer;
begin
  if p_bucket_key is null or p_bucket_key = '' or p_window_seconds < 1 or p_max_requests < 1 then
    raise exception 'invalid rate limit parameters';
  end if;

  -- Serialize the same bucket before the read/insert decision. This prevents two
  -- first requests racing through the UPSERT and resetting the counter.
  perform pg_advisory_xact_lock(hashtextextended('elemarket:rate-limit:' || p_bucket_key, 0));

  -- Do not scan/delete the entire bucket table on every request. On a small
  -- deterministic sample, remove a bounded batch of expired buckets. This keeps
  -- hot-path latency stable while preventing unbounded growth.
  if mod(abs(hashtextextended(p_bucket_key, 1)), 100) = 0 then
    delete from api_rate_limit_buckets
     where ctid in (
       select ctid from api_rate_limit_buckets
        where expires_at <= v_now
        order by expires_at
        limit 250
     );
  end if;

  select * into v_row
    from api_rate_limit_buckets
   where bucket_key = p_bucket_key
   for update;

  if not found or v_row.expires_at <= v_now then
    v_window_start := v_now;
    insert into api_rate_limit_buckets(bucket_key, window_start, request_count, expires_at)
    values (p_bucket_key, v_window_start, 1, v_now + make_interval(secs => p_window_seconds));
    return jsonb_build_object(
      'allowed', true,
      'remaining', greatest(p_max_requests - 1, 0),
      'resetAt', extract(epoch from (v_now + make_interval(secs => p_window_seconds)))::bigint
    );
  end if;

  v_allowed := v_row.request_count < p_max_requests;
  if v_allowed then
    update api_rate_limit_buckets
       set request_count = request_count + 1
     where bucket_key = p_bucket_key
    returning * into v_row;
  end if;

  v_remaining := greatest(p_max_requests - v_row.request_count, 0);
  return jsonb_build_object(
    'allowed', v_allowed,
    'remaining', v_remaining,
    'resetAt', extract(epoch from v_row.expires_at)::bigint
  );
end;
$$;

comment on table api_rate_limit_buckets is
  'Shared fixed-window API rate-limit counters; bucket keys are hashed and contain no raw client address.';
