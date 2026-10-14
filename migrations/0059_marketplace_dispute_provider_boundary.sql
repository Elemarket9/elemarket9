-- ELEMARKET marketplace boundary.
-- Dispute resolution changes marketplace order/dispute state only.
-- Payment-provider settlement/refunds happen outside ELEMARKET.
-- Do not create local merchant payout/settlement records as a result of a dispute.

create or replace function resolve_escrow_dispute(
  p_dispute_id text,
  p_resolution text,
  p_admin_id text,
  p_note text default ''
)
returns jsonb language plpgsql as $$
declare
  v_d record;
  v_e record;
  v_state text;
begin
  if p_resolution not in ('release','refund') then
    raise exception 'invalid dispute resolution';
  end if;
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then
    raise exception 'admin identity required';
  end if;

  perform pg_advisory_xact_lock(hashtext('elemarket:dispute:'||p_dispute_id));
  select * into v_d from escrow_disputes where id=p_dispute_id for update;
  if not found then raise exception 'dispute not found'; end if;
  if v_d.status not in ('open','under_review') then raise exception 'dispute already resolved'; end if;
  select * into v_e from escrows where id=v_d.escrow_id for update;

  if p_resolution='release' then
    if v_e.state not in ('disputed','release_pending','delivered','fulfilling','held') then
      raise exception 'order cannot be released from current marketplace state';
    end if;
    update escrow_disputes
       set status='resolved_release', resolution_note=p_note, resolved_by=p_admin_id, resolved_at=now()
     where id=v_d.id;
    update escrows
       set state='released', released_at=now(), updated_at=now()
     where id=v_e.id;
    v_state := 'released';
  else
    if v_e.state in ('released','settled') then
      raise exception 'released order requires provider refund workflow';
    end if;
    update escrow_disputes
       set status='resolved_refund', resolution_note=p_note, resolved_by=p_admin_id, resolved_at=now()
     where id=v_d.id;
    update escrows set state='refund_pending', updated_at=now() where id=v_e.id;
    v_state := 'refund_pending';
  end if;

  perform record_audit_event(
    'admin.dispute.'||p_resolution,
    'escrow_dispute',
    v_d.id,
    p_admin_id,
    'admin',
    null,
    'success',
    jsonb_build_object(
      'resolution',p_resolution,
      'escrowId',v_e.id,
      'state',v_state,
      'providerActionRequired',true
    )
  );

  return jsonb_build_object(
    'disputeId',v_d.id,
    'escrowId',v_e.id,
    'resolution',p_resolution,
    'state',v_state,
    'providerActionRequired',true
  );
end;
$$;
