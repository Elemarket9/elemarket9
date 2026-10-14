-- Fix the conflict target to match observability_counters' composite primary key.
create or replace function increment_observability_counter(
  p_metric_key text,
  p_delta bigint default 1
)
returns void
language plpgsql
as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
begin
  insert into observability_counters(
    metric_key,
    bucket_start,
    value
  )
  values (
    p_metric_key,
    v_bucket,
    p_delta
  )
  on conflict(metric_key, bucket_start) do update
    set value = observability_counters.value + excluded.value,
        updated_at = now();
end;
$$;
