import type { Sql } from "@/lib/db";
import { isWorkspacePreview } from "@/lib/env.server";

/** Optional isolated-development provider bootstrap, disabled by default.
 * Shared environments never register preview providers. Existing provider
 * status and settings remain authoritative, including an operator's deactivation.
 */
export async function ensurePreviewCommerce(sql: Sql): Promise<void> {
  if (!isWorkspacePreview() || process.env.ELEMARKET_ENABLE_PREVIEW_COMMERCE !== "1") return;
  await sql.query(
    `insert into payment_providers (id, provider_key, name, method, status, driver_key, requires_merchant_account)
     values
       ('pp-preview-momo', 'preview', 'Preview collection', 'mobile_money', 'active', 'http', false),
       ('pp-preview-card', 'preview-card', 'Preview card', 'card', 'active', 'http', false),
       ('pp-preview-bank', 'preview-bank', 'Preview bank transfer', 'bank_transfer', 'active', 'http', false)
     on conflict (provider_key) do nothing`,
  );
}
