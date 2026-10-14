-- v1.89: final legacy escrow execution lockdown.
-- ELEMARKET is provider-settled and non-custodial. Historical escrow tables may
-- remain for migration/audit compatibility, but no live function may mutate
-- escrow state or create local settlement records.

create or replace function mark_escrow_release_pending(p_order_id text)
returns jsonb language plpgsql as $$
begin
  raise exception 'legacy escrow release-window execution is disabled; provider settlement remains authoritative';
end;
$$;

create or replace function open_escrow_dispute(p_escrow_id text, p_user_id text, p_reason text)
returns jsonb language plpgsql as $$
begin
  raise exception 'legacy escrow disputes are disabled; use customer marketplace disputes';
end;
$$;

create or replace function resolve_escrow_dispute(p_dispute_id text, p_resolution text, p_admin_id text, p_note text default '')
returns jsonb language plpgsql as $$
begin
  raise exception 'legacy escrow dispute resolution is disabled; provider refund workflow is authoritative';
end;
$$;

revoke all on function mark_escrow_release_pending(text) from public;
revoke all on function open_escrow_dispute(text,text,text) from public;
revoke all on function resolve_escrow_dispute(text,text,text,text) from public;
revoke all on function prepare_provider_refund_for_payment(text,text,text) from public;
