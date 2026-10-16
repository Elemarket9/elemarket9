-- Approved allocation is required before independently handed over shipment jobs.
-- Admin approvals never create delivery receipt or financial eligibility.
CREATE TABLE IF NOT EXISTS shipment_delivery_allocations (
 shipment_id text PRIMARY KEY REFERENCES shipments(id) ON DELETE RESTRICT,
 provider_id text NOT NULL REFERENCES delivery_providers(id) ON DELETE RESTRICT,
 approved_by text NOT NULL,
 approved_at timestamptz NOT NULL DEFAULT now(),
 created_job_id text UNIQUE REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
 CHECK(length(approved_by)>0)
);
CREATE INDEX IF NOT EXISTS shipment_delivery_allocation_provider_idx ON shipment_delivery_allocations(provider_id,approved_at DESC);
-- Gate shipment-specific jobs against server-reviewed provider allocation.
CREATE OR REPLACE FUNCTION elemarket_guard_shipment_job_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF new.shipment_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM shipment_delivery_allocations a
   WHERE a.shipment_id=new.shipment_id AND a.provider_id=new.provider_id
 ) THEN RAISE EXCEPTION 'shipment provider assignment requires independent approval'; END IF;
 RETURN new;
END $$;
DROP TRIGGER IF EXISTS elemarket_shipment_job_allocation_gate ON delivery_jobs;
CREATE TRIGGER elemarket_shipment_job_allocation_gate BEFORE INSERT OR UPDATE OF shipment_id,provider_id ON delivery_jobs
FOR EACH ROW EXECUTE FUNCTION elemarket_guard_shipment_job_allocation();
