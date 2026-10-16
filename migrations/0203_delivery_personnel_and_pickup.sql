-- Independent personnel capabilities and pickup custody reuse existing jobs,
-- invitations, challenges, verifiers and immutable receipt evidence.
CREATE TABLE pickup_locations (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES partner_organizations(id) ON DELETE RESTRICT,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 160),
 address text NOT NULL CHECK(length(trim(address)) BETWEEN 8 AND 400),
 contact_phone text NOT NULL CHECK(contact_phone ~ '^\+233[25][0-9]{8}$'),
 latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','closed')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id)
);
CREATE INDEX pickup_location_org_status ON pickup_locations(organization_id,status);
CREATE TABLE delivery_personnel_capabilities (
 organization_id text NOT NULL, user_id text NOT NULL,
 capability text NOT NULL CHECK(capability IN ('rider','pickup_attendant','dispatcher','supervisor')),
 status text NOT NULL CHECK(status IN ('active','suspended','revoked')),
 accepted_at timestamptz NOT NULL, granted_by text NOT NULL,
 PRIMARY KEY(organization_id,user_id,capability),
 FOREIGN KEY(organization_id,user_id) REFERENCES partner_organization_users(organization_id,user_id) ON DELETE RESTRICT
);
CREATE INDEX delivery_personnel_user ON delivery_personnel_capabilities(user_id,status,organization_id);
-- Preserve existing independently activated riders, never promote administrators.
INSERT INTO delivery_personnel_capabilities(organization_id,user_id,capability,status,accepted_at,granted_by)
SELECT organization_id,user_id,'rider',status,activated_at,'migration:accepted-rider'
FROM partner_organization_users WHERE role='rider' AND activated_at IS NOT NULL;
CREATE TABLE pickup_location_attendants (
 organization_id text NOT NULL, location_id text NOT NULL, user_id text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','revoked')),
 PRIMARY KEY(location_id,user_id),
 FOREIGN KEY(organization_id,location_id) REFERENCES pickup_locations(organization_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,user_id) REFERENCES partner_organization_users(organization_id,user_id) ON DELETE RESTRICT
);
CREATE INDEX pickup_attendant_user ON pickup_location_attendants(user_id,organization_id,status);
ALTER TABLE provider_rider_invitations ADD COLUMN capability text NOT NULL DEFAULT 'rider'
 CHECK(capability IN ('rider','pickup_attendant','dispatcher','supervisor'));
ALTER TABLE provider_rider_invitations ADD COLUMN pickup_location_id text;
ALTER TABLE provider_rider_invitations ADD CONSTRAINT invitation_pickup_org_fk
 FOREIGN KEY(organization_id,pickup_location_id) REFERENCES pickup_locations(organization_id,id);
ALTER TABLE provider_rider_invitations ADD CONSTRAINT invitation_pickup_scope
 CHECK((capability='pickup_attendant')=(pickup_location_id IS NOT NULL));
DROP INDEX provider_rider_one_pending_email;
CREATE UNIQUE INDEX provider_personnel_pending_email ON provider_rider_invitations
 (organization_id,lower(invited_email),capability,coalesce(pickup_location_id,'')) WHERE status='pending';
CREATE INDEX invitation_pickup_location ON provider_rider_invitations(pickup_location_id) WHERE pickup_location_id IS NOT NULL;

ALTER TABLE delivery_jobs ADD COLUMN handover_kind text NOT NULL DEFAULT 'delivery' CHECK(handover_kind IN ('delivery','pickup'));
ALTER TABLE delivery_jobs ADD COLUMN pickup_location_id text REFERENCES pickup_locations(id) ON DELETE RESTRICT;
ALTER TABLE delivery_jobs ADD COLUMN pickup_arrived_at timestamptz;
ALTER TABLE delivery_jobs ADD COLUMN collection_due_at timestamptz;
ALTER TABLE delivery_jobs ADD CONSTRAINT pickup_job_scope CHECK((handover_kind='pickup')=(pickup_location_id IS NOT NULL));
CREATE INDEX pickup_job_location ON delivery_jobs(pickup_location_id,status) WHERE pickup_location_id IS NOT NULL;
ALTER TABLE shipments ADD COLUMN fulfillment_method text NOT NULL DEFAULT 'delivery' CHECK(fulfillment_method IN ('delivery','pickup'));
ALTER TABLE shipments ADD COLUMN pickup_location_id text REFERENCES pickup_locations(id) ON DELETE RESTRICT;
ALTER TABLE shipments ADD CONSTRAINT shipment_pickup_scope CHECK((fulfillment_method='pickup')=(pickup_location_id IS NOT NULL));
CREATE INDEX shipment_pickup_location ON shipments(pickup_location_id) WHERE pickup_location_id IS NOT NULL;
CREATE TABLE delivery_operation_events (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
 organization_id text NOT NULL REFERENCES partner_organizations(id), actor_user_id text NOT NULL,
 event_type text NOT NULL CHECK(event_type IN ('arrived','available','collection_failed','uncollected','return_requested','returned','exception','reassigned')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_operation_history ON delivery_operation_events(job_id,created_at);
CREATE INDEX delivery_operation_org ON delivery_operation_events(organization_id,created_at);
CREATE TABLE delivery_notification_outbox (
 id text PRIMARY KEY, job_id text NOT NULL REFERENCES delivery_jobs(id),
 kind text NOT NULL CHECK(kind='collection_ready'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','accepted','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 lease_token text, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 accepted_at timestamptz, UNIQUE(job_id,kind)
);
CREATE INDEX collection_notification_due ON delivery_notification_outbox(status,next_attempt_at);

CREATE FUNCTION elemarket_has_personnel_capability(p_org text,p_user text,p_cap text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM delivery_personnel_capabilities c
 JOIN partner_organization_users m ON m.organization_id=c.organization_id AND m.user_id=c.user_id AND m.status='active'
 JOIN "user" u ON u.id=c.user_id AND u."emailVerified" AND u."moderationStatus"='active'
 WHERE c.organization_id=p_org AND c.user_id=p_user AND c.capability=p_cap AND c.status='active')
$$;
CREATE FUNCTION elemarket_authorized_handover_person(p_job text,p_user text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM delivery_jobs j
 JOIN delivery_providers p ON p.id=j.provider_id AND p.status='active'
 JOIN partner_organizations o ON o.id=p.partner_organization_id AND o.status='active'
 WHERE j.id=p_job AND j.handover_rider_user_id=p_user
 AND elemarket_has_personnel_capability(o.id,p_user,CASE WHEN j.handover_kind='pickup' THEN 'pickup_attendant' ELSE 'rider' END)
 AND (j.handover_kind='delivery' OR EXISTS(
  SELECT 1 FROM pickup_locations l JOIN pickup_location_attendants a ON a.location_id=l.id AND a.organization_id=l.organization_id
  WHERE l.id=j.pickup_location_id AND l.organization_id=o.id AND l.status='active' AND a.user_id=p_user AND a.status='active')))
$$;
CREATE OR REPLACE FUNCTION elemarket_guard_handover_rider_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_id text;
BEGIN
 IF new.handover_rider_user_id IS DISTINCT FROM old.handover_rider_user_id THEN
  IF old.status NOT IN ('assigned','accepted','picked_up','in_transit') THEN RAISE EXCEPTION 'cannot change personnel after receipt'; END IF;
  IF EXISTS(SELECT 1 FROM delivery_handover_requests WHERE job_id=old.id AND state IN ('issuing','issued') AND expires_at>now()) THEN
   RAISE EXCEPTION 'cannot reassign during active handover'; END IF;
  SELECT partner_organization_id INTO org_id FROM delivery_providers WHERE id=new.provider_id;
  IF new.handover_rider_user_id IS NULL OR NOT elemarket_has_personnel_capability(org_id,new.handover_rider_user_id,
    CASE WHEN new.handover_kind='pickup' THEN 'pickup_attendant' ELSE 'rider' END) THEN RAISE EXCEPTION 'exact accepted personnel capability required'; END IF;
  IF new.handover_kind='pickup' AND NOT EXISTS(SELECT 1 FROM pickup_location_attendants WHERE location_id=new.pickup_location_id
    AND organization_id=org_id AND user_id=new.handover_rider_user_id AND status='active') THEN RAISE EXCEPTION 'wrong pickup location'; END IF;
  new.handover_rider_assigned_at:=now();
 END IF;
 RETURN new;
END $$;
CREATE OR REPLACE FUNCTION elemarket_guard_rider_confirmed_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.status IN ('delivered','completed') AND (tg_op='INSERT' OR old.status IS DISTINCT FROM new.status) THEN
  IF tg_op='UPDATE' AND old.status='delivered' AND old.customer_received_at IS NOT NULL AND new.status='completed' THEN RETURN new; END IF;
  IF NOT EXISTS(SELECT 1 FROM order_delivery_handover h JOIN delivery_jobs j ON j.id=h.job_id AND j.order_id=h.order_id
   JOIN otp_challenges c ON c.id=h.challenge_id AND c.status='verified'
   WHERE h.order_id=new.id AND h.verified_at IS NOT NULL AND h.verified_by=h.initiated_by
    AND elemarket_authorized_handover_person(j.id,h.verified_by)
    AND c.purpose='delivery_handover' AND c.user_id=new.user_id AND c.destination=new.delivery_contact_phone
    AND h.issued_at<=h.verified_at AND h.verified_at<=c.expires_at) THEN
   RAISE EXCEPTION 'authorized personnel initiated OTP receipt required';
  END IF;
 END IF;
 RETURN new;
END $$;
CREATE FUNCTION elemarket_guard_pickup_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_id text;
BEGIN
 SELECT partner_organization_id INTO org_id FROM delivery_providers WHERE id=new.provider_id;
 IF new.handover_kind='pickup' AND (new.shipment_id IS NULL OR NOT EXISTS(SELECT 1 FROM pickup_locations l
   JOIN shipments s ON s.id=new.shipment_id AND s.pickup_location_id=l.id AND s.fulfillment_method='pickup'
   WHERE l.id=new.pickup_location_id AND l.organization_id=org_id AND l.status='active')) THEN
  RAISE EXCEPTION 'pickup parcel/location/provider mismatch'; END IF;
 IF tg_op='UPDATE' AND (new.handover_kind IS DISTINCT FROM old.handover_kind OR new.pickup_location_id IS DISTINCT FROM old.pickup_location_id) THEN
  RAISE EXCEPTION 'handover fulfillment identity is immutable'; END IF;
 IF tg_op='UPDATE' AND old.pickup_arrived_at IS NOT NULL AND new.pickup_arrived_at IS DISTINCT FROM old.pickup_arrived_at THEN
  RAISE EXCEPTION 'parcel arrival history is immutable'; END IF;
 RETURN new;
END $$;
CREATE TRIGGER pickup_job_binding BEFORE INSERT OR UPDATE ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION elemarket_guard_pickup_job();
CREATE FUNCTION elemarket_append_only_delivery_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'delivery operation evidence is append-only'; END $$;
CREATE TRIGGER delivery_event_immutable BEFORE UPDATE OR DELETE ON delivery_operation_events FOR EACH ROW EXECUTE FUNCTION elemarket_append_only_delivery_event();
-- Snapshot the collection location once a provider job exists.
CREATE FUNCTION elemarket_guard_fulfillment_method() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (new.fulfillment_method IS DISTINCT FROM old.fulfillment_method OR new.pickup_location_id IS DISTINCT FROM old.pickup_location_id)
   AND EXISTS(SELECT 1 FROM delivery_jobs WHERE shipment_id=old.id) THEN RAISE EXCEPTION 'allocated fulfillment method is immutable'; END IF;
 RETURN new;
END $$;
CREATE TRIGGER shipment_method_immutable BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION elemarket_guard_fulfillment_method();
