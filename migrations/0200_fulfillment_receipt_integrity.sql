-- Additive repair; historical migration bytes remain unchanged.
-- Serialize allocations against other allocations and the order-first receipt
-- transaction. Locks are acquired before the aggregate is read.
CREATE OR REPLACE FUNCTION validate_shipment_graph()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_order text; v_merchant text; v_item_order text;
        v_ordered integer; v_shipped bigint;
BEGIN
 SELECT order_id INTO v_item_order FROM order_items WHERE id=new.order_item_id;
 PERFORM 1 FROM orders WHERE id=v_item_order FOR UPDATE;
 SELECT quantity INTO v_ordered FROM order_items WHERE id=new.order_item_id FOR UPDATE;
 SELECT order_id,merchant_id INTO v_order,v_merchant FROM shipments WHERE id=new.shipment_id FOR UPDATE;
 IF v_order IS NULL OR v_item_order IS NULL OR v_order IS DISTINCT FROM v_item_order THEN
   RAISE EXCEPTION 'shipment item does not belong to shipment order';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM orders WHERE id=v_order AND merchant_id=v_merchant) THEN
   RAISE EXCEPTION 'shipment merchant/order mismatch';
 END IF;
 SELECT coalesce(sum(si.quantity),0) INTO v_shipped FROM shipment_items si
 JOIN shipments s ON s.id=si.shipment_id
 WHERE si.order_item_id=new.order_item_id AND s.status<>'cancelled' AND si.id<>new.id;
 IF v_shipped+new.quantity>v_ordered THEN RAISE EXCEPTION 'shipment quantity exceeds ordered quantity'; END IF;
 RETURN new;
END $$;

CREATE OR REPLACE FUNCTION elemarket_guard_verified_handover_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF old.verified_at IS NOT NULL THEN
   IF tg_op='DELETE' THEN RAISE EXCEPTION 'verified handover evidence is immutable'; END IF;
   IF new IS DISTINCT FROM old THEN RAISE EXCEPTION 'verified handover evidence is immutable'; END IF;
 END IF;
 IF tg_op='DELETE' THEN RETURN old; END IF;
 RETURN new;
END $$;
DROP TRIGGER elemarket_handover_immutable_gate ON order_delivery_handover;
CREATE TRIGGER elemarket_handover_immutable_gate BEFORE UPDATE OR DELETE ON order_delivery_handover
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_verified_handover_immutable();

CREATE FUNCTION elemarket_guard_consumed_verifier_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF old.consumed_at IS NOT NULL THEN
   IF tg_op='DELETE' THEN RAISE EXCEPTION 'consumed verifier evidence is immutable'; END IF;
   IF new IS DISTINCT FROM old THEN RAISE EXCEPTION 'consumed verifier evidence is immutable'; END IF;
 END IF;
 IF tg_op='DELETE' THEN RETURN old; END IF;
 RETURN new;
END $$;
CREATE TRIGGER elemarket_consumed_verifier_immutable BEFORE UPDATE OR DELETE ON delivery_otp_verifiers
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_consumed_verifier_immutable();

CREATE FUNCTION elemarket_guard_shipment_creation_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.status='delivered' OR new.delivered_at IS NOT NULL THEN
   RAISE EXCEPTION 'new shipment cannot assert a verified receipt';
 END IF;
 RETURN new;
END $$;
CREATE TRIGGER elemarket_shipment_initial_receipt_gate BEFORE INSERT ON shipments
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_shipment_creation_state();
