-- Forward-only correction: storage upload purposes must match the server policy.
-- Historical 0066 allowed dispute-evidence but not the refund and financing purposes.
ALTER TABLE storage_upload_intents DROP CONSTRAINT IF EXISTS storage_upload_intents_purpose_check;
ALTER TABLE storage_upload_intents ADD CONSTRAINT storage_upload_intents_purpose_check
 CHECK (purpose IN ('product-image','profile-image','business-document','dispute-evidence',
                   'refund-evidence','order-attachment','financing-application-document'));

-- One verified intent can be attached to exactly one product media row.
ALTER TABLE storage_upload_intents ADD COLUMN IF NOT EXISTS consumed_at timestamptz;
ALTER TABLE product_media ADD COLUMN IF NOT EXISTS upload_intent_id text REFERENCES storage_upload_intents(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS product_media_upload_intent_uq ON product_media(upload_intent_id)
 WHERE upload_intent_id IS NOT NULL;
