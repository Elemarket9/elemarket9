-- Security/operations alerting and bounded telemetry maintenance.
create table if not exists security_alerts (
  id bigserial primary key,
  alert_key text not null,
  severity text not null check (severity in ('warn','error','critical')),
  event_name text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  dedupe_key text,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);
create index if not exists security_alerts_time_idx on security_alerts(created_at desc);
create index if not exists security_alerts_dedupe_time_idx on security_alerts(dedupe_key, created_at desc);

create or replace function record_security_alert(
  p_alert_key text,
  p_severity text,
  p_event_name text,
  p_message text,
  p_metadata jsonb default '{}'::jsonb,
  p_dedupe_key text default null
) returns void language plpgsql as $$
begin
  if p_alert_key is null or char_length(trim(p_alert_key)) < 2 then raise exception 'invalid alert key'; end if;
  if p_severity not in ('warn','error','critical') then raise exception 'invalid alert severity'; end if;
  if p_event_name is null or char_length(trim(p_event_name)) < 2 then raise exception 'invalid alert event'; end if;
  if p_message is null or char_length(trim(p_message)) < 2 then raise exception 'invalid alert message'; end if;

  if p_dedupe_key is null or not exists (
    select 1 from security_alerts
     where dedupe_key=p_dedupe_key
       and created_at > now() - interval '10 minutes'
  ) then
    insert into security_alerts(alert_key,severity,event_name,message,metadata,dedupe_key)
    values(p_alert_key,p_severity,p_event_name,left(p_message,1000),coalesce(p_metadata,'{}'::jsonb),p_dedupe_key);
  end if;
end;
$$;

comment on table security_alerts is 'Operational security alerts; application logs are the primary transport and this table is the durable audit/alert queue.';
