-- Reassignment deliberately clears personnel after challenges are invalidated.
-- Clearing must not be interpreted as assigning an unauthorized new rider.
CREATE OR REPLACE FUNCTION elemarket_guard_handover_rider_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_id text;
BEGIN
 IF new.handover_rider_user_id IS DISTINCT FROM old.handover_rider_user_id THEN
  IF old.status NOT IN ('assigned','accepted','picked_up','in_transit') THEN RAISE EXCEPTION 'cannot change personnel after receipt'; END IF;
  IF EXISTS(SELECT 1 FROM delivery_handover_requests WHERE job_id=old.id AND state IN ('issuing','issued') AND expires_at>now()) THEN RAISE EXCEPTION 'cannot reassign during active handover'; END IF;
  IF new.handover_rider_user_id IS NULL AND new.provider_id IS DISTINCT FROM old.provider_id THEN
   new.handover_rider_assigned_at:=NULL;RETURN new;
  END IF;
  SELECT partner_organization_id INTO org_id FROM delivery_providers WHERE id=new.provider_id;
  IF new.handover_rider_user_id IS NULL OR NOT elemarket_has_personnel_capability(org_id,new.handover_rider_user_id,
    CASE WHEN new.handover_kind='pickup' THEN 'pickup_attendant' ELSE 'rider' END) THEN RAISE EXCEPTION 'exact accepted personnel capability required'; END IF;
  IF new.handover_kind='pickup' AND NOT EXISTS(SELECT 1 FROM pickup_location_attendants WHERE location_id=new.pickup_location_id AND organization_id=org_id
    AND user_id=new.handover_rider_user_id AND status='active') THEN RAISE EXCEPTION 'wrong pickup location'; END IF;
  new.handover_rider_assigned_at:=now();
 END IF;RETURN new;
END $$;
CREATE FUNCTION elemarket_guard_initial_job_method() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.shipment_id IS NOT NULL AND EXISTS(SELECT 1 FROM shipments WHERE id=new.shipment_id AND fulfillment_method<>new.handover_kind) THEN
  RAISE EXCEPTION 'job fulfillment method must match its shipment'; END IF;
 RETURN new;
END $$;
CREATE TRIGGER initial_job_method_gate BEFORE INSERT ON delivery_jobs FOR EACH ROW EXECUTE FUNCTION elemarket_guard_initial_job_method();
