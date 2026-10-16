CREATE TABLE delivery_contact_recoveries (
 id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id),customer_id text NOT NULL,
 old_phone text,new_phone text NOT NULL CHECK(new_phone ~ '^\+233[25][0-9]{8}$'),
 proof_challenge_id text NOT NULL UNIQUE REFERENCES otp_challenges(id),
 identity_evidence_reference text NOT NULL CHECK(length(identity_evidence_reference) BETWEEN 12 AND 500),
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','applied','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(),applied_at timestamptz
);
CREATE UNIQUE INDEX delivery_contact_one_recovery ON delivery_contact_recoveries(order_id) WHERE status='requested';
CREATE INDEX delivery_contact_customer ON delivery_contact_recoveries(customer_id,created_at);
CREATE TABLE delivery_contact_recovery_reviews (
 recovery_id text NOT NULL REFERENCES delivery_contact_recoveries(id),reviewer_id text NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 12 AND 1000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(recovery_id,reviewer_id)
);
CREATE INDEX delivery_contact_reviewer ON delivery_contact_recovery_reviews(reviewer_id,created_at);
CREATE FUNCTION elemarket_recovery_reviewer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM delivery_contact_recoveries r JOIN "user" u ON u.id=new.reviewer_id AND u.role='admin' AND u."moderationStatus"='active'
  JOIN admin_staff_roles a ON a.user_id=u.id AND a.status='active'
  WHERE r.id=new.recovery_id AND r.customer_id<>new.reviewer_id AND r.status='requested'
   AND (a.staff_role='owner' OR EXISTS(SELECT 1 FROM admin_role_permissions p WHERE p.role_key=a.staff_role AND p.capability IN ('admin.full','admin.support')))) THEN
  RAISE EXCEPTION 'independent authorized support reviewer required'; END IF;
 RETURN new;
END $$;
CREATE TRIGGER recovery_reviewer_gate BEFORE INSERT ON delivery_contact_recovery_reviews FOR EACH ROW EXECUTE FUNCTION elemarket_recovery_reviewer_guard();
CREATE TRIGGER recovery_review_immutable BEFORE UPDATE OR DELETE ON delivery_contact_recovery_reviews FOR EACH ROW EXECUTE FUNCTION elemarket_append_only_delivery_event();
CREATE FUNCTION elemarket_contact_recovery_approved(p_order text,p_phone text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM delivery_contact_recoveries r JOIN orders o ON o.id=r.order_id AND o.user_id=r.customer_id
  JOIN otp_challenges c ON c.id=r.proof_challenge_id AND c.user_id=r.customer_id AND c.destination=r.new_phone
   AND c.purpose='phone_verification' AND c.status='verified' AND c.verified_at>=now()-interval '30 minutes'
  WHERE r.order_id=p_order AND r.new_phone=p_phone AND r.old_phone IS NOT DISTINCT FROM o.delivery_contact_phone AND r.status='requested'
   AND (SELECT count(*) FROM delivery_contact_recovery_reviews v WHERE v.recovery_id=r.id AND v.decision='approved')>=2
   AND NOT EXISTS(SELECT 1 FROM delivery_contact_recovery_reviews v WHERE v.recovery_id=r.id AND v.decision='rejected'))
$$;
CREATE OR REPLACE FUNCTION elemarket_guard_paid_delivery_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE phone text; verified timestamptz; recovery boolean:=false;
BEGIN
 IF tg_op='UPDATE' THEN recovery:=elemarket_contact_recovery_approved(old.id,new.delivery_contact_phone); END IF;
 IF tg_op='INSERT' THEN
  SELECT p.phone,p.phone_verified_at INTO phone,verified FROM profiles p WHERE p.user_id=new.user_id;
  IF phone IS NULL OR phone !~ '^\+233[25][0-9]{8}$' OR verified IS NULL THEN RAISE EXCEPTION 'verified customer phone required before physical checkout'; END IF;
 END IF;
 IF tg_op='UPDATE' AND old.status IN ('payment_pending','expired') AND new.status IN ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed') AND new.address IS DISTINCT FROM old.address THEN
  RAISE EXCEPTION 'delivery address cannot change during payment confirmation'; END IF;
 IF tg_op='UPDATE' AND old.status NOT IN ('payment_pending','expired') THEN
  IF new.address IS DISTINCT FROM old.address OR (new.delivery_contact_phone IS DISTINCT FROM old.delivery_contact_phone AND NOT recovery) THEN
   RAISE EXCEPTION 'paid order address/contact requires independent recovery'; END IF;
 END IF;
 IF new.status IN ('paid','confirmed','fulfilling','shipped','delivered','completed','disputed') AND (tg_op='INSERT' OR(tg_op='UPDATE' AND old.status IN ('payment_pending','expired'))) THEN
  SELECT p.phone,p.phone_verified_at INTO phone,verified FROM profiles p WHERE p.user_id=new.user_id;
  IF phone IS NULL OR phone !~ '^\+233[25][0-9]{8}$' OR verified IS NULL THEN RAISE EXCEPTION 'verified customer phone required before payment acceptance'; END IF;
  new.delivery_contact_phone:=phone;new.delivery_contact_snapshot_verified:=true;
 ELSIF tg_op='UPDATE' AND new.delivery_contact_snapshot_verified AND NOT old.delivery_contact_snapshot_verified AND NOT recovery THEN
  RAISE EXCEPTION 'legacy contact requires independently verified recovery';
 END IF;
 RETURN new;
END $$;
CREATE FUNCTION elemarket_apply_contact_recovery(p_request text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE target delivery_contact_recoveries%rowtype; order_key text;
BEGIN
 SELECT order_id INTO order_key FROM delivery_contact_recoveries WHERE id=p_request;
 PERFORM 1 FROM orders WHERE id=order_key AND status IN ('paid','confirmed','fulfilling','shipped') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'order cannot undergo contact recovery'; END IF;
 SELECT * INTO target FROM delivery_contact_recoveries WHERE id=p_request FOR UPDATE;
 IF target.status='applied' THEN RETURN false; END IF;
 IF NOT elemarket_contact_recovery_approved(target.order_id,target.new_phone) THEN RAISE EXCEPTION 'two independent approvals and fresh phone ownership proof required'; END IF;
 UPDATE delivery_handover_requests SET state='failed',updated_at=now() WHERE order_id=target.order_id AND state IN ('issuing','issued');
 UPDATE otp_challenges c SET status='superseded',updated_at=now() FROM delivery_otp_verifiers v
  WHERE c.id=v.challenge_id AND v.order_id=target.order_id AND v.consumed_at IS NULL AND c.status IN ('sending','pending');
 UPDATE orders SET delivery_contact_phone=target.new_phone,delivery_contact_snapshot_verified=true,updated_at=now() WHERE id=target.order_id;
 UPDATE delivery_contact_recoveries SET status='applied',applied_at=now() WHERE id=p_request;
 RETURN true;
END $$;

ALTER TABLE return_requests ADD COLUMN shipment_id text REFERENCES shipments(id) ON DELETE RESTRICT;
ALTER TABLE return_requests ADD COLUMN payment_id text REFERENCES payments(id) ON DELETE RESTRICT;
ALTER TABLE return_requests ADD COLUMN client_request_key text;
ALTER TABLE return_requests ADD COLUMN refund_amount numeric(12,2) CHECK(refund_amount>0);
CREATE UNIQUE INDEX return_idempotency ON return_requests(customer_id,client_request_key) WHERE client_request_key IS NOT NULL;
DROP INDEX return_requests_active_item_uq;
CREATE UNIQUE INDEX return_requests_active_item_shipment ON return_requests(order_item_id,shipment_id) NULLS NOT DISTINCT
 WHERE status IN ('requested','approved','received','refund_pending');
CREATE INDEX return_shipment ON return_requests(shipment_id,order_item_id,status);
CREATE INDEX return_payment ON return_requests(payment_id) WHERE payment_id IS NOT NULL;
ALTER TABLE delivery_operation_events ADD COLUMN exception_code text;
CREATE FUNCTION elemarket_guard_shipment_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocated integer; returned bigint; candidates integer;
BEGIN
 PERFORM 1 FROM orders WHERE id=new.order_id AND user_id=new.customer_id AND merchant_id=new.merchant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'return customer/order/merchant mismatch'; END IF;
 IF tg_op='INSERT' THEN
  SELECT round((product_total/quantity)*new.quantity,2) INTO new.refund_amount FROM order_items WHERE id=new.order_item_id AND order_id=new.order_id;
  IF new.payment_id IS NULL THEN SELECT id INTO new.payment_id FROM payments WHERE order_id=new.order_id; END IF;
 END IF;
 IF tg_op='INSERT' AND new.shipment_id IS NULL THEN
  SELECT count(*) INTO candidates FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id
   WHERE si.order_item_id=new.order_item_id AND s.order_id=new.order_id AND s.delivered_at IS NOT NULL;
  IF candidates<>1 THEN RAISE EXCEPTION 'return requires explicit received shipment'; END IF;
  SELECT si.shipment_id INTO new.shipment_id FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id
   WHERE si.order_item_id=new.order_item_id AND s.order_id=new.order_id AND s.delivered_at IS NOT NULL;
 END IF;
 PERFORM 1 FROM shipments WHERE id=new.shipment_id AND order_id=new.order_id AND delivered_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'return requires verified shipment receipt'; END IF;
 SELECT quantity INTO allocated FROM shipment_items WHERE shipment_id=new.shipment_id AND order_item_id=new.order_item_id;
 SELECT coalesce(sum(quantity),0) INTO returned FROM return_requests WHERE shipment_id=new.shipment_id
   AND order_item_id=new.order_item_id AND id<>new.id AND status NOT IN ('rejected','cancelled');
 IF allocated IS NULL OR returned+(CASE WHEN new.status IN ('rejected','cancelled') THEN 0 ELSE new.quantity END)>allocated THEN RAISE EXCEPTION 'return quantity exceeds received shipment allocation'; END IF;
 IF tg_op='UPDATE' AND (new.order_id IS DISTINCT FROM old.order_id OR new.customer_id IS DISTINCT FROM old.customer_id
  OR new.order_item_id IS DISTINCT FROM old.order_item_id OR new.shipment_id IS DISTINCT FROM old.shipment_id OR new.quantity IS DISTINCT FROM old.quantity
  OR new.payment_id IS DISTINCT FROM old.payment_id OR new.refund_amount IS DISTINCT FROM old.refund_amount
  OR new.client_request_key IS DISTINCT FROM old.client_request_key) THEN RAISE EXCEPTION 'return fulfillment identity is immutable'; END IF;
 IF new.payment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payments WHERE id=new.payment_id AND order_id=new.order_id AND user_id=new.customer_id) THEN RAISE EXCEPTION 'return payment mismatch'; END IF;
 IF new.provider_refund_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM provider_refund_requests r WHERE r.id=new.provider_refund_request_id
   AND r.order_id=new.order_id AND r.payment_id=new.payment_id) THEN RAISE EXCEPTION 'return refund association mismatch'; END IF;
 IF new.status='refunded' AND NOT EXISTS(SELECT 1 FROM provider_refund_requests r WHERE r.id=new.provider_refund_request_id
   AND r.order_id=new.order_id AND r.payment_id=new.payment_id AND r.status='processed' AND r.provider_refund_id IS NOT NULL AND r.amount=new.refund_amount) THEN
   RAISE EXCEPTION 'external provider refund evidence required'; END IF;
 RETURN new;
END $$;
CREATE TRIGGER return_fulfillment_guard BEFORE INSERT OR UPDATE ON return_requests FOR EACH ROW EXECUTE FUNCTION elemarket_guard_shipment_return();

CREATE FUNCTION elemarket_recovery_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF tg_op='DELETE' THEN RAISE EXCEPTION 'recovery evidence is immutable'; END IF;
 IF old.status<>'requested' OR new.order_id IS DISTINCT FROM old.order_id OR new.customer_id IS DISTINCT FROM old.customer_id
  OR new.old_phone IS DISTINCT FROM old.old_phone OR new.new_phone IS DISTINCT FROM old.new_phone
  OR new.proof_challenge_id IS DISTINCT FROM old.proof_challenge_id OR new.identity_evidence_reference IS DISTINCT FROM old.identity_evidence_reference
  OR new.created_at IS DISTINCT FROM old.created_at THEN RAISE EXCEPTION 'recovery evidence is immutable'; END IF;
 RETURN new;
END $$;
CREATE TRIGGER recovery_identity_gate BEFORE UPDATE OR DELETE ON delivery_contact_recoveries FOR EACH ROW EXECUTE FUNCTION elemarket_recovery_identity_immutable();

CREATE OR REPLACE FUNCTION enforce_delivery_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.status IS DISTINCT FROM old.status AND NOT (
  (old.status='assigned' AND new.status IN ('accepted','cancelled')) OR
  (old.status='accepted' AND new.status IN ('picked_up','failed','cancelled')) OR
  (old.status='picked_up' AND new.status IN ('in_transit','failed')) OR
  (old.status='in_transit' AND new.status IN ('delivered','failed')) OR
  (old.status IN ('delivered','failed') AND new.status='return_requested') OR
  (old.status='return_requested' AND new.status='returned')) THEN
  RAISE EXCEPTION 'invalid delivery job transition % -> %',old.status,new.status; END IF;
 IF new.status='accepted' AND new.accepted_at IS NULL THEN new.accepted_at:=now(); END IF;
 IF new.status='picked_up' AND new.picked_up_at IS NULL THEN new.picked_up_at:=now(); END IF;
 IF new.status='in_transit' AND new.in_transit_at IS NULL THEN new.in_transit_at:=now(); END IF;
 IF new.status='delivered' AND new.delivered_at IS NULL THEN new.delivered_at:=now(); END IF;
 IF new.status='failed' AND new.failed_at IS NULL THEN new.failed_at:=now(); END IF;
 IF new.status='return_requested' AND new.return_requested_at IS NULL THEN new.return_requested_at:=now(); END IF;
 IF new.status='returned' AND new.returned_at IS NULL THEN new.returned_at:=now(); END IF;
 new.version:=old.version+1;new.updated_at:=now();RETURN new;
END $$;
-- Closed/suspended locations still retain custody/return history. Live location
-- activation is checked by handover authority, not by every historical UPDATE.
CREATE OR REPLACE FUNCTION elemarket_guard_pickup_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_id text;
BEGIN
 SELECT partner_organization_id INTO org_id FROM delivery_providers WHERE id=new.provider_id;
 IF new.handover_kind='pickup' AND (new.shipment_id IS NULL OR NOT EXISTS(SELECT 1 FROM pickup_locations l
   JOIN shipments s ON s.id=new.shipment_id AND s.pickup_location_id=l.id AND s.fulfillment_method='pickup'
   WHERE l.id=new.pickup_location_id AND l.organization_id=org_id)) THEN RAISE EXCEPTION 'pickup parcel/location/provider mismatch'; END IF;
 IF tg_op='UPDATE' AND (new.handover_kind IS DISTINCT FROM old.handover_kind OR new.pickup_location_id IS DISTINCT FROM old.pickup_location_id) THEN
   RAISE EXCEPTION 'handover fulfillment identity is immutable'; END IF;
 IF tg_op='UPDATE' AND old.pickup_arrived_at IS NOT NULL AND new.pickup_arrived_at IS DISTINCT FROM old.pickup_arrived_at THEN
   RAISE EXCEPTION 'parcel arrival history is immutable'; END IF;
 RETURN new;
END $$;
