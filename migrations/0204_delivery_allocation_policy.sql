-- Configured service availability is explicitly labelled. Prices come from
-- actual persisted customer quotes, never a fabricated policy price.
ALTER TABLE provider_rider_invitations ADD COLUMN notification_version integer NOT NULL DEFAULT 0 CHECK(notification_version>=0);
ALTER TABLE shipments ADD COLUMN weight_kg numeric(12,3) CHECK(weight_kg>0);
CREATE TABLE delivery_allocation_policies (
 provider_id text PRIMARY KEY REFERENCES delivery_providers(id) ON DELETE RESTRICT,
 enabled boolean NOT NULL DEFAULT false, priority integer NOT NULL DEFAULT 100 CHECK(priority BETWEEN 0 AND 10000),
 modes text[] NOT NULL DEFAULT ARRAY['delivery']::text[] CHECK(cardinality(modes)>0 AND modes<@ARRAY['delivery','pickup']::text[]),
 min_lat double precision NOT NULL CHECK(min_lat BETWEEN -90 AND 90),max_lat double precision NOT NULL CHECK(max_lat BETWEEN -90 AND 90),
 min_lon double precision NOT NULL CHECK(min_lon BETWEEN -180 AND 180),max_lon double precision NOT NULL CHECK(max_lon BETWEEN -180 AND 180),
 max_weight_kg numeric(12,3) CHECK(max_weight_kg>0),
 availability_source text NOT NULL CHECK(availability_source IN ('configured','externally_confirmed')),
 evidence_reference text NOT NULL CHECK(length(trim(evidence_reference)) BETWEEN 8 AND 500),
 valid_until timestamptz NOT NULL, updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(min_lat<=max_lat AND min_lon<=max_lon)
);
CREATE INDEX delivery_policy_enabled ON delivery_allocation_policies(priority,provider_id) WHERE enabled;
ALTER TABLE shipment_delivery_allocations ADD COLUMN quote_id text REFERENCES delivery_quotes(id);
ALTER TABLE shipment_delivery_allocations ADD COLUMN availability_source text CHECK(availability_source IN ('configured','externally_confirmed','manual_review'));
CREATE INDEX shipment_allocation_quote ON shipment_delivery_allocations(quote_id) WHERE quote_id IS NOT NULL;

CREATE FUNCTION elemarket_guard_personnel_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.status='active' AND (tg_op='INSERT' OR old.status IS DISTINCT FROM new.status OR old.accepted_at IS DISTINCT FROM new.accepted_at) THEN
  IF NOT EXISTS(SELECT 1 FROM provider_rider_invitations i JOIN "user" u ON u.id=new.user_id AND lower(u.email)=lower(i.invited_email) AND u."emailVerified"
    WHERE i.organization_id=new.organization_id AND i.capability=new.capability AND i.status='accepted'
      AND i.accepted_by=new.user_id AND i.accepted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'personnel capability requires individual invitation acceptance';
  END IF;
 END IF;
 RETURN new;
END $$;
CREATE TRIGGER personnel_acceptance_gate BEFORE INSERT OR UPDATE ON delivery_personnel_capabilities
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_personnel_activation();
