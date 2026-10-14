-- REWRITTEN 2026-10-13 with user authorization; NOT the historical bytes.
-- The new checksum is suitable for clean installs only. Existing databases
-- with the original checksum must undergo explicit migration reconciliation.
create or replace function audit_admin_dispute_resolution_atomic()
returns trigger language plpgsql as $$
declare v_role text;
begin
  if new.status is distinct from old.status and new.status in ('resolved_release','resolved_refund') then
    select role into v_role from "user" where id=new.resolved_by;
    if v_role is distinct from 'admin' then raise exception 'admin identity required for dispute resolution'; end if;
    perform record_audit_event('admin.dispute.resolution_atomic','escrow_dispute',new.id,new.resolved_by,'admin',null,'success',
      jsonb_build_object('fromStatus',old.status,'toStatus',new.status,'escrowId',new.escrow_id));
  end if;
  return new;
end $$;
create trigger admin_dispute_resolution_atomic after update of status on escrow_disputes
for each row execute function audit_admin_dispute_resolution_atomic();
revoke all on function resolve_escrow_dispute(text,text,text,text) from public;
