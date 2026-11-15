-- Retail back-office permissions (orders, fraud review, review moderation,
-- marketplace promotions, reports, and read-only roles). Allow-list only;
-- each feature migration that follows adds its own tables and functions.
--
-- Backfill keeps today's job roles working:
--   support    -> may view orders (needed to answer "where is my order?")
--   operations -> may view orders, review fraud flags and moderate reviews
-- Nobody loses access; the Main Administrator can adjust any role afterwards.

alter table admin_role_permissions drop constraint if exists admin_role_permissions_capability_check;
alter table admin_role_permissions add constraint admin_role_permissions_capability_check check (capability in (
  'admin.full','admin.operations','admin.support',
  'admin.merchants.review','admin.merchants.moderate',
  'admin.customers.moderate','admin.products.moderate','admin.categories.manage',
  'admin.enterprise.manage','admin.providers.manage','admin.financing.manage',
  'admin.campaigns.manage','admin.audit.read','admin.staff.directory',
  'admin.finance.refunds','admin.finance.policy','admin.finance.view',
  'admin.staff.manage',
  'admin.overview.view','admin.finance.payouts',
  'admin.orders.view','admin.orders.manage','admin.risk.review','admin.reviews.moderate',
  'admin.promotions.manage','admin.reports.view','admin.support.view','admin.catalog.view'
));

insert into admin_role_permissions(role_key, capability) values
  ('support','admin.orders.view'),
  ('operations','admin.orders.view'),
  ('operations','admin.risk.review'),
  ('operations','admin.reviews.moderate')
on conflict do nothing;
