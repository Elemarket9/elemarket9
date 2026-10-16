-- Staging migration: independently verified phone evidence and fulfillment-scoped handover.
-- Migration is additive to all historical records; never retrofit legacy OTP proof.
-- Production application must be deployed in lockstep with this schema change.
ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS shipment_id text REFERENCES shipments(id) ON DELETE RESTRICT;
ALTER TABLE delivery_jobs DROP CONSTRAINT IF EXISTS delivery_jobs_order_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_job_per_shipment ON delivery_jobs(shipment_id) WHERE shipment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_job_unshipped_per_order ON delivery_jobs(order_id) WHERE shipment_id IS NULL;
CREATE INDEX IF NOT EXISTS delivery_jobs_order_shipment_idx ON delivery_jobs(order_id,shipment_id);

-- Handover proof must belong to the physical job, not an entire order.
ALTER TABLE order_delivery_handover DROP CONSTRAINT IF EXISTS order_delivery_handover_pkey;
ALTER TABLE order_delivery_handover ADD PRIMARY KEY (job_id);
CREATE INDEX IF NOT EXISTS handover_order_receipt_idx ON order_delivery_handover(order_id,verified_at);
ALTER TABLE delivery_handover_requests DROP CONSTRAINT IF EXISTS delivery_handover_requests_pkey;
ALTER TABLE delivery_handover_requests ADD PRIMARY KEY (job_id);
CREATE INDEX IF NOT EXISTS handover_requests_order_idx ON delivery_handover_requests(order_id);

-- A shipment job must belong to the same order as its shipment. Do not allow
-- dispatch of an order-wide job after the shipment graph has been established.
CREATE OR REPLACE FUNCTION elemarket_guard_delivery_shipment_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.shipment_id IS DISTINCT FROM old.shipment_id AND tg_op='UPDATE' THEN
   RAISE EXCEPTION 'delivery job shipment identity is immutable';
 END IF;
 IF new.shipment_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM shipments s WHERE s.id=new.shipment_id AND s.order_id=new.order_id) THEN
     RAISE EXCEPTION 'shipment and job belong to different orders';
   END IF;
 ELSIF EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=new.order_id) THEN
   RAISE EXCEPTION 'shipment order requires shipment-scoped delivery job';
 END IF;
 RETURN new;
END $$;
-- BEFORE UPDATE trigger works with an existing row; INSERT must be separate.
CREATE OR REPLACE FUNCTION elemarket_guard_delivery_shipment_binding_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.shipment_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM shipments s WHERE s.id=new.shipment_id AND s.order_id=new.order_id) THEN
     RAISE EXCEPTION 'shipment and job belong to different orders';
   END IF;
 ELSIF EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=new.order_id) THEN
   RAISE EXCEPTION 'shipment order requires shipment-scoped delivery job';
 END IF;
 RETURN new;
END $$;
DROP TRIGGER IF EXISTS elemarket_shipment_job_insert_gate ON delivery_jobs;
CREATE TRIGGER elemarket_shipment_job_insert_gate BEFORE INSERT ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION elemarket_guard_delivery_shipment_binding_insert();
DROP TRIGGER IF EXISTS elemarket_shipment_job_update_gate ON delivery_jobs;
CREATE TRIGGER elemarket_shipment_job_update_gate BEFORE UPDATE OF shipment_id,order_id ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION elemarket_guard_delivery_shipment_binding();

-- No unverified profile contact can be silently promoted to a verified order
-- snapshot. Existing paid snapshots without proof stay unverified.
CREATE OR REPLACE FUNCTION elemarket_guard_paid_delivery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_phone text; v_verified timestamptz;
BEGIN
 IF tg_op='INSERT' THEN
   SELECT phone,phone_verified_at INTO v_phone,v_verified FROM profiles WHERE user_id=new.user_id;
   IF v_phone IS NULL OR v_phone !~ '^\+233[25][0-9]{8}$' OR v_verified IS NULL THEN
     RAISE EXCEPTION 'verified customer phone required before physical checkout';
   END IF;
 END IF;
 IF tg_op='UPDATE' AND old.status in ('payment_pending','expired') AND
    new.status in ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed')
    AND new.address IS DISTINCT FROM old.address THEN
   RAISE EXCEPTION 'delivery address cannot change during payment confirmation';
 END IF;
 IF tg_op='UPDATE' AND old.status NOT IN ('payment_pending','expired') THEN
   IF new.address IS DISTINCT FROM old.address OR new.delivery_contact_phone IS DISTINCT FROM old.delivery_contact_phone THEN
     RAISE EXCEPTION 'paid order delivery address and phone are immutable';
   END IF;
 END IF;
 IF new.status IN ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed')
   AND (tg_op='INSERT' OR (tg_op='UPDATE' AND old.status IN ('payment_pending','expired'))) THEN
   SELECT phone,phone_verified_at INTO v_phone,v_verified FROM profiles WHERE user_id=new.user_id;
   IF v_phone IS NULL OR v_phone !~ '^\+233[25][0-9]{8}$' OR v_verified IS NULL THEN
     RAISE EXCEPTION 'verified customer phone required before payment acceptance';
   END IF;
   new.delivery_contact_phone:=v_phone;
   new.delivery_contact_snapshot_verified:=true;
 ELSIF tg_op='UPDATE' AND new.delivery_contact_snapshot_verified=true
       AND old.delivery_contact_snapshot_verified=false THEN
   RAISE EXCEPTION 'legacy contact proof cannot be asserted without independently verified recovery';
 END IF;
 RETURN new;
END $$;
-- Previously auto-certified snapshots cannot be trusted without original ownership proof.
-- Do not discard historical contact numbers. Only invalidate unproven assertion.
UPDATE orders o SET delivery_contact_snapshot_verified=false
WHERE o.delivery_contact_snapshot_verified=true
 AND NOT EXISTS(SELECT 1 FROM profiles p WHERE p.user_id=o.user_id
   AND p.phone=o.delivery_contact_phone AND p.phone_verified_at IS NOT NULL);

-- Fail-closed financial gate: order-level eligibility only after ALL its
-- fulfillment quantities and their individual signed-off shipment jobs complete.
-- Partial settlement needs separate item-level contracts and cannot inherit
-- this order-wide withdrawal calculation.
CREATE OR REPLACE FUNCTION elemarket_order_delivered_at(p_order_id text)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=p_order_id) THEN
  CASE WHEN
   NOT EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=p_order_id
     AND i.quantity <> COALESCE((SELECT sum(si.quantity) FROM shipment_items si
       JOIN shipments s ON s.id=si.shipment_id
       WHERE si.order_item_id=i.id AND s.order_id=p_order_id AND s.status='delivered'),0))
   AND NOT EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=p_order_id
     AND (s.status<>'delivered' OR NOT EXISTS (
       SELECT 1 FROM delivery_jobs j JOIN order_delivery_handover h
         ON h.job_id=j.id AND h.order_id=j.order_id
       JOIN delivery_otp_verifiers v ON v.challenge_id=h.challenge_id
         AND v.job_id=j.id AND v.consumed_at IS NOT NULL
       WHERE j.shipment_id=s.id AND j.order_id=p_order_id
         AND j.status='delivered' AND h.verified_at IS NOT NULL)))
   AND EXISTS(SELECT 1 FROM shipments s WHERE s.order_id=p_order_id)
   AND NOT EXISTS(SELECT 1 FROM delivery_jobs j WHERE j.order_id=p_order_id AND j.shipment_id IS NULL)
  THEN (SELECT max(h.verified_at) FROM order_delivery_handover h WHERE h.order_id=p_order_id AND h.verified_at IS NOT NULL)
  ELSE NULL END
 ELSE COALESCE(
    (SELECT max(h.verified_at) FROM order_delivery_handover h
      JOIN delivery_jobs j ON j.id=h.job_id AND j.order_id=h.order_id
      JOIN delivery_otp_verifiers v ON v.challenge_id=h.challenge_id AND v.consumed_at IS NOT NULL
      WHERE h.order_id=p_order_id AND h.verified_at IS NOT NULL AND j.status='delivered'),
    (SELECT o.customer_received_at FROM orders o WHERE o.id=p_order_id
      AND o.delivery_confirmation_source IN ('customer_confirmation','delivery_otp')))
 END
$$;

-- Neither carrier callbacks nor a manually edited order row can turn one
-- verified parcel into full-order receipt when sibling parcels remain open.
CREATE OR REPLACE FUNCTION elemarket_guard_all_shipments_received() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.status='delivered' AND (tg_op='INSERT' OR old.status IS DISTINCT FROM 'delivered') THEN
   IF EXISTS (SELECT 1 FROM shipments s WHERE s.order_id=new.id) AND
     (elemarket_order_delivered_at(new.id) IS NULL OR
      new.customer_received_at IS DISTINCT FROM elemarket_order_delivered_at(new.id)) THEN
     RAISE EXCEPTION 'every shipment requires distinct verified receipt before order completion';
   END IF;
 END IF;
 RETURN new;
END $$;
DROP TRIGGER IF EXISTS elemarket_all_shipments_receipt_gate ON orders;
CREATE TRIGGER elemarket_all_shipments_receipt_gate BEFORE INSERT OR UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_all_shipments_received();

CREATE OR REPLACE FUNCTION elemarket_guard_shipment_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.status='delivered' AND old.status IS DISTINCT FROM 'delivered' THEN
   IF NOT EXISTS (SELECT 1 FROM delivery_jobs j JOIN order_delivery_handover h
     ON h.job_id=j.id AND h.verified_at IS NOT NULL
     JOIN delivery_otp_verifiers v ON v.challenge_id=h.challenge_id AND v.consumed_at IS NOT NULL
     WHERE j.shipment_id=new.id AND j.order_id=new.order_id AND j.status='delivered') THEN
     RAISE EXCEPTION 'shipment receipt requires a consumed, job-specific OTP';
   END IF;
 END IF;
 RETURN new;
END $$;
DROP TRIGGER IF EXISTS elemarket_shipment_receipt_gate ON shipments;
CREATE TRIGGER elemarket_shipment_receipt_gate BEFORE UPDATE OF status ON shipments
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_shipment_receipt();

-- A verified receipt is immutable; exception resolution must not rewrite it.
CREATE OR REPLACE FUNCTION elemarket_guard_verified_handover_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF old.verified_at IS NOT NULL AND
   (new.verified_at IS DISTINCT FROM old.verified_at OR new.verified_by IS DISTINCT FROM old.verified_by
    OR new.challenge_id IS DISTINCT FROM old.challenge_id OR new.job_id IS DISTINCT FROM old.job_id) THEN
   RAISE EXCEPTION 'verified handover evidence is immutable';
 END IF;
 RETURN new;
END $$;
DROP TRIGGER IF EXISTS elemarket_handover_immutable_gate ON order_delivery_handover;
CREATE TRIGGER elemarket_handover_immutable_gate BEFORE UPDATE ON order_delivery_handover
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_verified_handover_immutable();
