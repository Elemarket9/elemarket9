alter table payment_providers add column if not exists driver_key text not null default 'http';

-- Provider integrations are selected by database configuration, never by vendor name in marketplace business logic.
comment on column payment_providers.driver_key is 'Integration driver selected by deployment configuration; the marketplace domain is provider-neutral.';

-- Existing vendor rows are intentionally not activated by this migration. Operators must explicitly configure the driver and credentials for the selected provider.
update payment_providers set status='review' where status='active';
