-- Tracking URLs belong to a vetted delivery-provider origin registry.
-- Default deny: operators cannot redirect customers to arbitrary HTTPS sites.
alter table delivery_providers
  add column if not exists tracking_allowed_origins text[] not null default '{}'::text[];
comment on column delivery_providers.tracking_allowed_origins is
  'Approved HTTPS origins for this provider, e.g. https://tracking.example.com. An empty array forbids partner-submitted links.';
