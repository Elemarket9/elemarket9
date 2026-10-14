-- Runtime provider neutrality.
-- Historical migrations may contain provider records for environments that used
-- a particular PSP. Runtime selection must not depend on vendor names.
-- Operators explicitly choose a driver and capabilities for each provider.
update payment_providers
set driver_key = 'http'
where driver_key is null or driver_key = '';

comment on column payment_providers.driver_key is
  'Deployment-selected adapter driver. The marketplace core does not map driver names to vendors.';
