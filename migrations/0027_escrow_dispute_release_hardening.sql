-- v1.48: dispute-release hardening.
-- An admin dispute resolution may authorize release, but it must obey the same
-- verified merchant payout-destination invariant as normal escrow release.
-- It still does not move funds; the licensed custody provider does that later.

create or replace function resolve_escrow_dispute(p_dispute_id text, p_resolution text, p_admin_id text, p_note text default '')
returns jsonb language plpgsql as $$
declare
  v_d record;
  v_e record;
  v_destination text;
  v_settlement text;
begin
  if p_resolution not in ('release','refund') then raise exception 'invalid dispute resolution'; end if;
  if p_admin_id is null or length(trim(p_admin_id)) < 1 then raise exception 'admin identity required'; end if;
  perform pg_advisory_xact_lock(hashtext('elemarket:dispute:'||p_dispute_id));
  select * into v_d from escrow_disputes where id=p_dispute_id for update;
  if not found then raise exception 'dispute not found'; end if;
  if v_d.status not in ('open','under_review') then raise exception 'dispute already resolved'; end if;
  select * into v_e from escrows where id=v_d.escrow_id for update;

  if p_resolution='release' then
    if v_e.state not in ('disputed','release_pending','delivered','fulfilling','held') then
      raise exception 'escrow cannot be released from current state';
    end if;
    select destination_ref into v_destination
      from merchant_payout_accounts
     where merchant_id=v_e.merchant_id and status='verified'
     order by updated_at desc
     limit 1;
    if v_destination is null or length(trim(v_destination)) = 0 then
      raise exception 'merchant payout account is not verified';
    end if;

    v_settlement := 'set_'||replace(gen_random_uuid()::text,'-','');
    update escrow_disputes
       set status='resolved_release',resolution_note=p_note,resolved_by=p_admin_id,resolved_at=now()
     where id=v_d.id;
    update escrows
       set state='released',released_at=now(),updated_at=now()
     where id=v_e.id;
    insert into merchant_settlements(id,escrow_id,merchant_id,amount,status,payout_destination_ref)
      values(v_settlement,v_e.id,v_e.merchant_id,v_e.merchant_entitlement,'eligible',v_destination)
      on conflict(escrow_id) do nothing;
    insert into escrow_ledger_entries(escrow_id,entry_type,direction,amount,reference,metadata)
      values(v_e.id,'release','debit',v_e.merchant_entitlement,p_dispute,
             jsonb_build_object('resolution','release','adminId',p_admin_id,'settlementId',v_settlement))
      on conflict do nothing;
  else
    if v_e.state in ('released','settled') then raise exception 'released escrow requires post-settlement refund workflow'; end if;
    update escrow_disputes
       set status='resolved_refund',resolution_note=p_note,resolved_by=p_admin_id,resolved_at=now()
     where id=v_d.id;
    update escrows set state='refund_pending',updated_at=now() where id=v_e.id;
  end if;
  return jsonb_build_object('disputeId',v_d.id,'escrowId',v_e.id,'resolution',p_resolution,
                            'state',(select state from escrows where id=v_e.id));
end;
$$;
