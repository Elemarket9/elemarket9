import type { Sql } from "@/lib/db";
import { isWorkspacePreview } from "@/lib/env.server";

/**
 * Preview-only commerce bootstrap.
 *
 * Production stays provider-neutral and unconfigured until operators activate
 * real adapters. The live preview still needs a complete shop flow, so we
 * register an explicit preview collection provider that never ships as active
 * via migrations.
 */
export async function ensurePreviewCommerce(sql: Sql): Promise<void> {
  if (!isWorkspacePreview()) return;
  await sql.query(
    `insert into payment_providers (id, provider_key, name, method, status, driver_key, requires_merchant_account)
     values
       ('pp-preview-momo', 'preview', 'Preview collection', 'mobile_money', 'active', 'http', false),
       ('pp-preview-card', 'preview-card', 'Preview card', 'card', 'active', 'http', false),
       ('pp-preview-bank', 'preview-bank', 'Preview bank transfer', 'bank_transfer', 'active', 'http', false)
     on conflict (provider_key) do update
       set status = 'active',
           driver_key = 'http',
           requires_merchant_account = false,
           updated_at = now()`,
  );
}
