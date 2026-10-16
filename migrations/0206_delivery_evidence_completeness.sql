-- Four executable regressions demonstrated mutable ancillary receipt evidence.
-- Freeze its identity rather than relying only on the shipment timestamp guard.
CREATE FUNCTION elemarket_personnel_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.organization_id IS DISTINCT FROM old.organization_id OR new.user_id IS DISTINCT FROM old.user_id
  OR new.capability IS DISTINCT FROM old.capability OR new.accepted_at IS DISTINCT FROM old.accepted_at
  OR new.granted_by IS DISTINCT FROM old.granted_by THEN RAISE EXCEPTION 'accepted personnel identity is immutable'; END IF;
 RETURN new;
END $$;
CREATE TRIGGER personnel_identity_gate BEFORE UPDATE ON delivery_personnel_capabilities FOR EACH ROW EXECUTE FUNCTION elemarket_personnel_identity_immutable();
CREATE FUNCTION elemarket_consumed_challenge_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM delivery_otp_verifiers WHERE challenge_id=old.id AND consumed_at IS NOT NULL) THEN
  IF tg_op='DELETE' THEN RAISE EXCEPTION 'consumed challenge evidence is immutable'; END IF;
  IF new IS DISTINCT FROM old THEN RAISE EXCEPTION 'consumed challenge evidence is immutable'; END IF;
 END IF;
 IF tg_op='DELETE' THEN RETURN old; END IF;RETURN new;
END $$;
CREATE TRIGGER consumed_challenge_gate BEFORE UPDATE OR DELETE ON otp_challenges FOR EACH ROW EXECUTE FUNCTION elemarket_consumed_challenge_immutable();
CREATE FUNCTION elemarket_receipt_job_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM order_delivery_handover WHERE job_id=old.id AND verified_at IS NOT NULL) AND
  (new.order_id IS DISTINCT FROM old.order_id OR new.provider_id IS DISTINCT FROM old.provider_id
   OR new.shipment_id IS DISTINCT FROM old.shipment_id OR new.handover_rider_user_id IS DISTINCT FROM old.handover_rider_user_id
   OR new.handover_kind IS DISTINCT FROM old.handover_kind OR new.pickup_location_id IS DISTINCT FROM old.pickup_location_id
   OR (old.delivered_at IS NOT NULL AND new.delivered_at IS DISTINCT FROM old.delivered_at)) THEN
  RAISE EXCEPTION 'verified receipt job identity and timestamp are immutable'; END IF;
 -- The first delivered timestamp must be the already verified receipt instant.
 IF new.delivered_at IS NOT NULL AND old.delivered_at IS NULL AND EXISTS(SELECT 1 FROM order_delivery_handover WHERE job_id=old.id AND verified_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM order_delivery_handover WHERE job_id=old.id AND verified_at=new.delivered_at) THEN
  RAISE EXCEPTION 'verified receipt job timestamp is immutable'; END IF;
 IF new.shipment_id IS NOT NULL AND EXISTS(SELECT 1 FROM shipments WHERE id=new.shipment_id AND fulfillment_method<>new.handover_kind) THEN
  RAISE EXCEPTION 'job fulfillment method must match its shipment'; END IF;
 RETURN new;
END $$;
CREATE TRIGGER receipt_job_evidence_gate BEFORE UPDATE ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION elemarket_receipt_job_immutable();
CREATE OR REPLACE FUNCTION elemarket_guard_allocated_order_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM shipment_items WHERE order_item_id=old.id) THEN
  IF tg_op='DELETE' THEN RAISE EXCEPTION 'allocated order item identity and economics are immutable'; END IF;
  IF new.order_id IS DISTINCT FROM old.order_id OR new.product_id IS DISTINCT FROM old.product_id
    OR new.variant_id IS DISTINCT FROM old.variant_id OR new.quantity IS DISTINCT FROM old.quantity
    OR new.unit_price IS DISTINCT FROM old.unit_price OR new.product_total IS DISTINCT FROM old.product_total
    OR new.discount_total IS DISTINCT FROM old.discount_total OR new.currency IS DISTINCT FROM old.currency THEN
   RAISE EXCEPTION 'allocated order item identity and economics are immutable'; END IF;
 END IF;
 IF tg_op='DELETE' THEN RETURN old; END IF;RETURN new;
END $$;
DROP TRIGGER elemarket_allocated_order_item_gate ON order_items;
CREATE TRIGGER elemarket_allocated_order_item_gate BEFORE DELETE OR UPDATE OF order_id,product_id,variant_id,quantity,unit_price,product_total,discount_total,currency ON order_items
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_allocated_order_item();
