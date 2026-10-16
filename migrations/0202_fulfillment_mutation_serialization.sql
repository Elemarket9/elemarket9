-- Receipt checks must run AFTER acquiring the same order-first lock as receipt
-- verification. A pre-lock EXISTS alone can miss a concurrently committed receipt.
CREATE OR REPLACE FUNCTION elemarket_lock_fulfillment_items()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shipment_key text; order_key text;
BEGIN
 IF tg_op='INSERT' THEN shipment_key:=new.shipment_id; ELSE shipment_key:=old.shipment_id; END IF;
 IF tg_op='UPDATE' AND new.shipment_id IS DISTINCT FROM old.shipment_id THEN
   RAISE EXCEPTION 'shipment-item ownership cannot be transferred';
 END IF;
 SELECT order_id INTO order_key FROM shipments WHERE id=shipment_key;
 PERFORM 1 FROM orders WHERE id=order_key FOR UPDATE;
 PERFORM 1 FROM shipments WHERE id=shipment_key FOR UPDATE;
 IF EXISTS(SELECT 1 FROM shipments s WHERE s.id=shipment_key AND
   (s.status='delivered' OR EXISTS(SELECT 1 FROM delivery_jobs j
    JOIN order_delivery_handover h ON h.job_id=j.id
    WHERE j.shipment_id=s.id AND h.verified_at IS NOT NULL))) THEN
   RAISE EXCEPTION 'cannot modify shipment quantities after customer receipt';
 END IF;
 IF tg_op='DELETE' THEN RETURN old; END IF;
 RETURN new;
END $$;

CREATE OR REPLACE FUNCTION elemarket_guard_new_shipment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_state text;
BEGIN
 SELECT status INTO order_state FROM orders WHERE id=new.order_id FOR UPDATE;
 IF order_state IN ('delivered','completed','disputed') THEN
   RAISE EXCEPTION 'cannot create parcels after order receipt or dispute';
 END IF;
 RETURN new;
END $$;

CREATE FUNCTION elemarket_guard_allocated_order_item()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM shipment_items WHERE order_item_id=old.id) THEN
   IF tg_op='DELETE' THEN RAISE EXCEPTION 'allocated order item identity and quantity are immutable'; END IF;
   IF new.order_id IS DISTINCT FROM old.order_id OR new.product_id IS DISTINCT FROM old.product_id
      OR new.variant_id IS DISTINCT FROM old.variant_id OR new.quantity IS DISTINCT FROM old.quantity THEN
     RAISE EXCEPTION 'allocated order item identity and quantity are immutable';
   END IF;
 END IF;
 IF tg_op='DELETE' THEN RETURN old; END IF;
 RETURN new;
END $$;
CREATE TRIGGER elemarket_allocated_order_item_gate BEFORE DELETE OR UPDATE OF order_id,product_id,variant_id,quantity ON order_items
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_allocated_order_item();
