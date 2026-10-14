-- Storage upload authorization/finalization state machine.
create table if not exists storage_upload_intents (
  id text primary key,
  user_id text not null references "user"("id") on delete cascade,
  purpose text not null check (purpose in ('product-image','profile-image','business-document','dispute-evidence','order-attachment')),
  resource_id text,
  object_key text not null unique,
  content_type text not null check (content_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 573440),
  status text not null check (status in ('authorized','verifying','verified','cleanup_pending','expired','rejected')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz
);
create index if not exists storage_upload_intents_user_idx on storage_upload_intents(user_id,status,created_at desc);
create index if not exists storage_upload_intents_expiry_idx on storage_upload_intents(expires_at) where status in ('authorized','verifying','rejected','cleanup_pending');

-- Marketplace media is image-only in the current product-upload policy.
alter table product_media drop constraint if exists product_media_type_check;
alter table product_media add constraint product_media_type_check check (media_type in ('image'));
