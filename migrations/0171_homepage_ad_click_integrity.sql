-- Prevent paid-media clicks being counted without a preceding observed impression.
-- All accounting changes and event deduplication remain in one PostgreSQL transaction.
create or replace function record_homepage_ad_event(
  p_event_id text, p_campaign_id text, p_event_type text, p_session_key text
) returns jsonb language plpgsql as $$
declare
  v_inserted boolean := false;
  v_count bigint := 0;
  v_cap bigint;
begin
  if p_event_id !~ '^[A-Za-z0-9_-]{16,128}$' then raise exception 'invalid ad event id'; end if;
  if p_session_key !~ '^[A-Za-z0-9_-]{32,128}$' then raise exception 'invalid ad visitor'; end if;
  if p_event_type not in ('impression','click') then raise exception 'invalid ad event type'; end if;

  -- Serializes impression caps and click counters on a single campaign row.
  select max_impressions into v_cap
    from homepage_ad_campaigns
   where id=p_campaign_id and status='active' and starts_at<=now() and ends_at>now()
   for update;
  if not found then return jsonb_build_object('recorded',false,'reason','campaign_inactive'); end if;

  if p_event_type='click' and not exists (
    select 1 from homepage_ad_events
     where campaign_id=p_campaign_id and event_type='impression'
       and session_key=p_session_key and created_at>=now()-interval '24 hours'
  ) then
    return jsonb_build_object('recorded',false,'reason','impression_required');
  end if;

  if p_event_type='impression' and v_cap is not null and not exists (
    select 1 from homepage_ad_campaigns where id=p_campaign_id and impression_count<v_cap
  ) then return jsonb_build_object('recorded',false,'reason','impression_cap_reached'); end if;

  insert into homepage_ad_events(id,campaign_id,event_type,session_key)
  values (p_event_id,p_campaign_id,p_event_type,p_session_key)
  on conflict (campaign_id,event_type,session_key) do nothing;
  get diagnostics v_inserted=row_count;

  if v_inserted then
    if p_event_type='impression' then
      update homepage_ad_campaigns set impression_count=impression_count+1,updated_at=now()
       where id=p_campaign_id and (max_impressions is null or impression_count<max_impressions);
      if not found then
        delete from homepage_ad_events where id=p_event_id;
        return jsonb_build_object('recorded',false,'reason','impression_cap_reached');
      end if;
    else
      update homepage_ad_campaigns set click_count=click_count+1,updated_at=now() where id=p_campaign_id;
    end if;
  end if;

  select case when p_event_type='impression' then impression_count else click_count end
    into v_count from homepage_ad_campaigns where id=p_campaign_id;
  return jsonb_build_object('recorded',v_inserted,'count',coalesce(v_count,0));
end;
$$;
revoke all on function record_homepage_ad_event(text,text,text,text) from public;

create index if not exists homepage_ad_event_impression_lookup_idx
  on homepage_ad_events(campaign_id,session_key,created_at desc)
  where event_type='impression';
