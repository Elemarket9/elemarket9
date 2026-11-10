-- Operational indexes and bounded retention. Historical checksums stay immutable.
-- pg_trgm is optional: embedded preview databases may not ship the extension.

do $$
begin
  begin
    create extension if not exists pg_trgm;
    execute 'create index if not exists products_normalized_name_trgm_idx on products using gin (normalized_name gin_trgm_ops)';
  exception
    when others then
      raise notice 'pg_trgm unavailable; leading-wildcard name search keeps the btree index';
  end;
end $$;

create index if not exists payments_inflight_created_idx
  on payments (created_at)
  where status in ('initiated','authorized') and provider_reference is not null;

create index if not exists orders_status_created_idx
  on orders (status, created_at desc);

-- Hot requests must not delete other people's rate-limit rows. The retention job does.
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

  perform pg_advisory_xact_lock(hashtextextended('elemarket:rate-limit:' || p_bucket_key, 0));

  select * into v_row
    from api_rate_limit_buckets
   where bucket_key = p_bucket_key
   for update;

  if not found or v_row.expires_at <= v_now then
    v_window_start := v_now;
    insert into api_rate_limit_buckets(bucket_key, window_start, request_count, expires_at)
    values (p_bucket_key, v_window_start, 1, v_now + make_interval(secs => p_window_seconds))
    on conflict (bucket_key) do update
      set window_start=excluded.window_start,
          request_count=excluded.request_count,
          expires_at=excluded.expires_at;
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

-- Each invocation deletes a bounded batch so a neglected table cannot lock the database.
create or replace function purge_operational_retention_data(p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  v_rate integer := 0;
  v_otp integer := 0;
  v_events integer := 0;
  v_counters integer := 0;
  v_days integer;
begin
  select retention_days into v_days from data_retention_policies where data_class='api_rate_limit_buckets';
  delete from api_rate_limit_buckets
   where ctid in (
     select ctid from api_rate_limit_buckets
      where expires_at < p_now - make_interval(days=>coalesce(v_days,2))::interval
      order by expires_at
      limit 5000
   );
  get diagnostics v_rate = row_count;

  select retention_days into v_days from data_retention_policies where data_class='otp_challenges';
  delete from otp_challenges
   where ctid in (
     select ctid from otp_challenges
      where status <> 'pending'
        and updated_at < p_now - make_interval(days=>coalesce(v_days,30))::interval
      order by updated_at
      limit 5000
   );
  get diagnostics v_otp = row_count;

  select retention_days into v_days from data_retention_policies where data_class='observability_events';
  delete from observability_events
   where ctid in (
     select ctid from observability_events
      where created_at < p_now - make_interval(days=>coalesce(v_days,90))::interval
      order by created_at
      limit 5000
   );
  get diagnostics v_events = row_count;

  select retention_days into v_days from data_retention_policies where data_class='observability_counters';
  delete from observability_counters
   where ctid in (
     select ctid from observability_counters
      where bucket_start < p_now - make_interval(days=>coalesce(v_days,90))::interval
      order by bucket_start
      limit 5000
   );
  get diagnostics v_counters = row_count;

  perform record_audit_event(
    'data.retention.purge', 'system', null, null, 'system', null, 'success',
    jsonb_build_object('rateLimitBuckets',v_rate,'otpChallenges',v_otp,'observabilityEvents',v_events,'observabilityCounters',v_counters)
  );
  return jsonb_build_object('rateLimitBuckets',v_rate,'otpChallenges',v_otp,'observabilityEvents',v_events,'observabilityCounters',v_counters);
end;
$$;
