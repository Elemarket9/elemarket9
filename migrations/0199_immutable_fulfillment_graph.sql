-- A receipt must not be diluted, moved or backdated by rewriting the shipment graph.
CREATE OR REPLACE FUNCTION elemarket_lock_fulfillment_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_shipment text;
BEGIN
 IF tg_op='DELETE' THEN v_shipment:=old.shipment_id;
 ELSIF tg_op='UPDATE' THEN
   IF new.shipment_id IS DISTINCT FROM old.shipment_id THEN
     RAISE EXCEPTION 'shipment-item ownership cannot be transferred';
   END IF;
   v_shipment:=old.shipment_id;
 ELSE v_shipment:=new.shipment_id; END IF;
 IF EXISTS(SELECT 1 FROM shipments s WHERE s.id=v_shipment AND
    (s.status='delivered' OR EXISTS(SELECT 1 FROM delivery_jobs j JOIN order_delivery_handover h ON h.job_id=j.id
      WHERE j.shipment_id=s.id AND h.verified_at IS NOT NULL))) THEN
   RAISE EXCEPTION 'cannot modify shipment quantities after customer receipt';
 END IF;
 IF tg_op='DELETE' THEN RETURN old; END IF;
 RETURN new;
END $$;
DROP TRIGGER IF EXISTS elemarket_shipment_items_immutable ON shipment_items;
CREATE TRIGGER elemarket_shipment_items_immutable BEFORE INSERT OR UPDATE OR DELETE ON shipment_items
FOR EACH ROW EXECUTE FUNCTION elemarket_lock_fulfillment_items();

CREATE OR REPLACE FUNCTION elemarket_guard_new_shipment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM orders o WHERE o.id=new.order_id AND
   o.status IN ('delivered','completed','disputed')) THEN
   RAISE EXCEPTION 'cannot create parcels after order receipt or dispute';
 END IF;
 RETURN new;
END $$;
DROP TRIGGER IF EXISTS elemarket_new_shipment_gate ON shipments;
CREATE TRIGGER elemarket_new_shipment_gate BEFORE INSERT ON shipments FOR EACH ROW
 EXECUTE FUNCTION elemarket_guard_new_shipment();

CREATE OR REPLACE FUNCTION elemarket_guard_shipment_receipt_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF old.delivered_at IS NOT NULL AND (new.delivered_at IS DISTINCT FROM old.delivered_at
     OR (new.status IS DISTINCT FROM old.status AND NOT (old.status='delivered' AND new.status='returned'))) THEN
   RAISE EXCEPTION 'confirmed shipment receipt and state cannot be rewritten';
 END IF;
 RETURN new;
END $$;
DROP TRIGGER IF EXISTS elemarket_shipment_receipt_clock_gate ON shipments;
CREATE TRIGGER elemarket_shipment_receipt_clock_gate BEFORE UPDATE ON shipments FOR EACH ROW
 EXECUTE FUNCTION elemarket_guard_shipment_receipt_timestamp();
