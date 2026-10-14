-- EIDE V10.1 forward repair: keep bounded event retention explicit in the latest
-- runtime contract. This intentionally does not edit historical migration 0163.
create or replace function prune_eide_events(p_limit integer default 2000)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare n1 integer:=0; n2 integer:=0; n3 integer:=0; v_limit integer:=least(greatest(p_limit,1),10000);
begin
  with doomed as (select ctid from eide_ranking_events where created_at<now()-interval '180 days' order by created_at asc limit v_limit)
  delete from eide_ranking_events e using doomed d where e.ctid=d.ctid; get diagnostics n1=row_count;
  with doomed as (select ctid from marketplace_product_events where created_at<now()-interval '120 days' order by created_at asc limit v_limit)
  delete from marketplace_product_events e using doomed d where e.ctid=d.ctid; get diagnostics n2=row_count;
  with doomed as (select ctid from marketplace_search_events where created_at<now()-interval '120 days' order by created_at asc limit v_limit)
  delete from marketplace_search_events e using doomed d where e.ctid=d.ctid; get diagnostics n3=row_count;
  return n1+n2+n3;
end $$;
revoke all on function prune_eide_events(integer) from public;
grant execute on function prune_eide_events(integer) to current_user;
