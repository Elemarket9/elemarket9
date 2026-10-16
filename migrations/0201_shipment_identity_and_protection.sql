-- Protection timestamps are set by verified handover, never by carrier callbacks.
ALTER TABLE shipments ADD COLUMN protection_ends_at timestamptz;
CREATE FUNCTION elemarket_guard_shipment_identity_and_protection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt_at timestamptz;
BEGIN
 IF new.order_id IS DISTINCT FROM old.order_id OR new.merchant_id IS DISTINCT FROM old.merchant_id THEN
   RAISE EXCEPTION 'shipment order and merchant identities are immutable';
 END IF;
 IF old.status='cancelled' AND new.status<>'cancelled' THEN
   RAISE EXCEPTION 'cancelled shipment cannot be revived; allocate a replacement parcel';
 END IF;
 IF old.delivered_at IS NOT NULL THEN
   IF new.protection_ends_at IS DISTINCT FROM old.protection_ends_at THEN
     RAISE EXCEPTION 'shipment protection deadline is immutable';
   END IF;
 ELSIF new.delivered_at IS NOT NULL OR new.status='delivered' THEN
   SELECT h.verified_at INTO receipt_at FROM delivery_jobs j
   JOIN order_delivery_handover h ON h.job_id=j.id AND h.order_id=j.order_id
   JOIN delivery_otp_verifiers v ON v.challenge_id=h.challenge_id AND v.job_id=j.id
     AND v.order_id=j.order_id AND v.consumed_at IS NOT NULL
   WHERE j.shipment_id=new.id AND j.order_id=new.order_id AND j.status='delivered'
     AND h.verified_at IS NOT NULL;
   IF receipt_at IS NULL OR new.status<>'delivered' OR new.delivered_at IS DISTINCT FROM receipt_at THEN
     RAISE EXCEPTION 'shipment receipt timestamp requires matching job-specific verified receipt';
   END IF;
   new.protection_ends_at:=receipt_at+interval '24 hours';
 ELSIF new.protection_ends_at IS DISTINCT FROM old.protection_ends_at THEN
   RAISE EXCEPTION 'unverified shipment cannot assert a protection deadline';
 END IF;
 RETURN new;
END $$;
CREATE TRIGGER elemarket_shipment_identity_protection_gate BEFORE UPDATE ON shipments
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_shipment_identity_and_protection();

-- Do not retroactively certify historical shipments. Missing protection evidence
-- is a release/reconciliation blocker, not grounds to fabricate a timestamp.
CREATE FUNCTION elemarket_guard_initial_protection_deadline()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.protection_ends_at IS NOT NULL THEN RAISE EXCEPTION 'new shipment cannot assert a protection deadline'; END IF;
 RETURN new;
END $$;
CREATE TRIGGER elemarket_shipment_initial_protection_gate BEFORE INSERT ON shipments
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_initial_protection_deadline();
