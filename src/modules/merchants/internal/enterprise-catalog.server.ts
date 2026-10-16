import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isPrivateOrReservedIp } from "@/lib/security/ssrf.server";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { encryptMerchantSensitiveData, decryptMerchantSensitiveData } from "@/lib/security/merchant-sensitive.server";
import { assertPublicHttpsEndpoint } from "@/lib/security/ssrf.server";
import { CATEGORY_KEYS, isValidSubcategory } from "@/modules/shared/public/categories";
import { approvedPublicMediaUrl } from "@/lib/security/public-media-origin.server";

const fieldMappingSchema = z.object({
  id: z.string().min(1).max(200),
  sku: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(200).optional(),
  category: z.string().min(1).max(120),
  subcategory: z.string().max(120).optional(),
  brand: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  price: z.string().min(1).max(200),
  currency: z.string().max(50).optional(),
  stock: z.string().min(1).max(200),
  image: z.string().max(200).optional(),
  warrantyMonths: z.string().max(200).optional(),
  attributes: z.string().max(200).optional(),
});

export type EnterpriseCatalogFieldMapping = z.infer<typeof fieldMappingSchema>;

type EnterpriseCatalogRecord = {
  id: string;
  sku?: string;
  name: string;
  description?: string;
  category: string;
  subcategory?: string;
  brand?: string;
  model?: string;
  price: number;
  currency?: string;
  stock: number;
  image?: string;
  warrantyMonths?: number;
  attributes: Record<string, unknown>;
  raw: Record<string, unknown>;
};

type Credentials = { token?: string; apiKey?: string; username?: string; password?: string };

function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, part) => {
    if (current == null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) return current[Number(part)];
    return (current as Record<string, unknown>)[part];
  }, value);
}

function stringValue(value: unknown, field: string, required = false): string | undefined {
  if (value == null) {
    if (required) throw new Error(`Enterprise catalog field ${field} is missing`);
    return undefined;
  }
  const text = String(value).trim();
  if (!text && required) throw new Error(`Enterprise catalog field ${field} is empty`);
  return text || undefined;
}

function numberValue(value: unknown, field: string, integer = false): number {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "object") {
    throw new Error(`Invalid enterprise catalog ${field}`);
  }
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) || !text.length) throw new Error(`Invalid enterprise catalog ${field}`);
  const n = Number(text);
  if (!Number.isSafeInteger(integer ? n : Math.trunc(n)) || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`Invalid enterprise catalog ${field}`);
  }
  return n;
}

// A partner must not supply fractional pesewas that silently round at the DB boundary.
function priceValue(value: unknown): number {
  if (value == null || typeof value === "boolean" || typeof value === "object") throw new Error("Invalid enterprise catalog price");
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(text)) throw new Error("Invalid enterprise catalog price");
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 100_000_000 * 100) throw new Error("Invalid enterprise catalog price");
  return cents / 100;
}

function publicEnterpriseImageUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname.length > 253
      || url.pathname.length > 2048 || url.search.length > 1024 || url.href.length > 2000) return null;
    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")
      || url.hostname.endsWith(".internal") || isPrivateOrReservedIp(url.hostname)) return null;
    return approvedPublicMediaUrl(url.href) ?? null;
  } catch { return null; }
}

function enterpriseAttributes(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid enterprise catalog attributes");
  const entries = Object.entries(value);
  if (entries.length > 64 || JSON.stringify(value).length > 4000) throw new Error("Enterprise catalog attributes exceed limits");
  const output: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (!/^[a-z_][a-z0-9_]{0,63}$/.test(key) || /^(?:__proto__|constructor|prototype)$/.test(key)
      || (entry !== null && typeof entry === "object")) throw new Error("Invalid enterprise catalog attribute");
    output[key] = entry;
  }
  return output;
}

async function validateEndpoint(endpoint: string): Promise<URL> {
  return assertPublicHttpsEndpoint(endpoint);
}

function normalizeRecord(raw: unknown, mapping: EnterpriseCatalogFieldMapping): EnterpriseCatalogRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Enterprise catalog item must be an object");
  const id = stringValue(getPath(raw, mapping.id), "id", true)!;
  const name = stringValue(getPath(raw, mapping.name), "name", true)!;
  const category = stringValue(getPath(raw, mapping.category), "category", true)!;
  if (!(CATEGORY_KEYS as readonly string[]).includes(category)) throw new Error(`Unsupported enterprise catalog category for ${id}`);
  const subcategory = mapping.subcategory ? stringValue(getPath(raw, mapping.subcategory), "subcategory") : undefined;
  if (subcategory && !isValidSubcategory(category, subcategory)) throw new Error(`Unsupported enterprise catalog subcategory for ${id}`);
  const price = priceValue(getPath(raw, mapping.price));
  const stock = numberValue(getPath(raw, mapping.stock), "stock", true);
  if (stock > 1000000) throw new Error(`Invalid enterprise catalog stock for ${id}`);
  const currency = stringValue(mapping.currency ? getPath(raw, mapping.currency) : "GHS", "currency") ?? "GHS";
  if (currency !== "GHS") throw new Error(`Unsupported enterprise catalog currency for ${id}`);
  const warranty = mapping.warrantyMonths ? stringValue(getPath(raw, mapping.warrantyMonths), "warrantyMonths") : undefined;
  return {
    id,
    sku: mapping.sku ? stringValue(getPath(raw, mapping.sku), "sku") : undefined,
    name,
    description: mapping.description ? stringValue(getPath(raw, mapping.description), "description") : undefined,
    category,
    subcategory,
    brand: mapping.brand ? stringValue(getPath(raw, mapping.brand), "brand") : undefined,
    model: mapping.model ? stringValue(getPath(raw, mapping.model), "model") : undefined,
    price,
    currency,
    stock,
    image: publicEnterpriseImageUrl(mapping.image ? stringValue(getPath(raw, mapping.image), "image") : undefined) ?? undefined,
    attributes: mapping.attributes ? enterpriseAttributes(getPath(raw, mapping.attributes)) : {},
    warrantyMonths: warranty == null ? undefined : numberValue(warranty, "warrantyMonths", true),
    raw: raw as Record<string, unknown>,
  };
}

export async function pinnedGet(url: URL, headers: Headers): Promise<{ status: number; body: string }> {
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const publicAddresses = addresses.map(a => a.address).filter(a => !isPrivateOrReservedIp(a));
  if (!publicAddresses.length) throw new Error("Enterprise catalog endpoint no longer resolves to a public address");
  const address = publicAddresses[0];
  return await new Promise((resolve, reject) => {
    const req = httpsRequest({
      protocol: "https:", hostname: address, port: 443, path: `${url.pathname}${url.search}`, method: "GET",
      servername: url.hostname, headers: { ...Object.fromEntries(headers.entries()), host: url.hostname },
      lookup: (_host, _opts, cb) => cb(null, address, address.includes(":") ? 6 : 4),
      timeout: 15_000,
    }, res => {
      let total = 0; const chunks: Buffer[] = [];
      res.on("data", chunk => { total += Buffer.byteLength(chunk); if (total > 10 * 1024 * 1024) { req.destroy(new Error("Enterprise catalog response too large")); return; } chunks.push(Buffer.from(chunk)); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Enterprise catalog request timed out")));
    req.on("error", reject); req.end();
  });
}

// redirect: "manual"
async function* fetchCatalogPages(connection: {
  endpoint_url: string;
  auth_type: "none" | "bearer" | "api_key" | "basic";
  credentials_encrypted: string | null;
  response_path: string;
  field_mapping: EnterpriseCatalogFieldMapping;
  cursor_param: string;
  cursor_path: string | null;
  page_size: number;
}): AsyncGenerator<{ records: EnterpriseCatalogRecord[]; page: number }, void, void> {
  const baseUrl = await validateEndpoint(connection.endpoint_url);
  const credentials = connection.credentials_encrypted ? decryptMerchantSensitiveData<Credentials>(connection.credentials_encrypted) : {};
  const headers = new Headers({ accept: "application/json" });
  if (connection.auth_type === "bearer") {
    if (!credentials.token) throw new Error("Enterprise catalog bearer token is not configured");
    headers.set("authorization", `Bearer ${credentials.token}`);
  } else if (connection.auth_type === "api_key") {
    if (!credentials.apiKey) throw new Error("Enterprise catalog API key is not configured");
    headers.set("x-api-key", credentials.apiKey);
  } else if (connection.auth_type === "basic") {
    if (!credentials.username || !credentials.password) throw new Error("Enterprise catalog basic credentials are not configured");
    headers.set("authorization", `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`);
  }

  let cursor: string | null = null;
  let page = 0;
  let total = 0;
  const seenCursors = new Set<string>();
  for (;;) {
    const url = new URL(baseUrl.toString());
    url.searchParams.set("limit", String(connection.page_size));
    if (cursor) url.searchParams.set(connection.cursor_param, cursor);
    const response = await pinnedGet(url, headers);
    if (response.status >= 300 && response.status < 400) throw new Error("Enterprise catalog redirects are not allowed");
    if (response.status < 200 || response.status >= 300) throw new Error(`Enterprise catalog API returned HTTP ${response.status}`);
    let payload: unknown;
    try { payload = JSON.parse(response.body); } catch { throw new Error("Enterprise catalog response is not valid JSON"); }
    const items = getPath(payload, connection.response_path);
    if (!Array.isArray(items)) throw new Error("Enterprise catalog response path is not an array");
    const records: EnterpriseCatalogRecord[] = [];
    for (const item of items) {
      if (total >= 50000) throw new Error("Enterprise catalog contains too many products in one sync");
      records.push(normalizeRecord(item, connection.field_mapping));
      total++;
    }
    page += 1;
    yield { records, page };
    if (!connection.cursor_path || items.length === 0) break;
    const next = getPath(payload, connection.cursor_path);
    const nextCursor = next == null ? null : String(next).trim();
    if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
    if (page >= 250) throw new Error("Enterprise catalog pagination exceeded the maximum page count");
  }
}

export async function syncEnterpriseCatalog(input: { merchantId: string; source?: "manual" | "scheduled" | "webhook" }) {
  const sql = await getSql();
  const source = input.source ?? "manual";
  const connections = await sql.query<{
    id: string; merchant_id: string; endpoint_url: string; auth_type: "none" | "bearer" | "api_key" | "basic";
    credentials_encrypted: string | null; response_path: string; field_mapping: EnterpriseCatalogFieldMapping;
    sync_mode: "upsert_only" | "snapshot"; status: string; cursor_param: string; cursor_path: string | null; page_size: number;
  }>(`select id,merchant_id,endpoint_url,auth_type,credentials_encrypted,response_path,field_mapping,sync_mode,status,cursor_param,cursor_path,page_size
        from enterprise_catalog_connections where merchant_id=$1`, [input.merchantId]);
  const connection = connections[0];
  if (!connection) throw new Error("Enterprise catalog connection not configured");
  if (connection.status !== "active") throw new Error("Enterprise catalog connection is not active");
  const merchantRows = await sql.query<{ settlement_model: string; catalog_source: string; status: string; verified: boolean }>(
    `select settlement_model,catalog_source,status,verified from merchants where id=$1`, [input.merchantId]);
  const merchant = merchantRows[0];
  if (!merchant || merchant.settlement_model !== "enterprise_direct" || merchant.catalog_source !== "enterprise_api" || merchant.status !== "active" || !merchant.verified) {
    throw new Error("Merchant is not an active verified enterprise API merchant");
  }

  const generationRows = await sql.query<{ generation: string }>(`select nextval('enterprise_catalog_generation_seq')::text as generation`);
  const generation = Number(generationRows[0]?.generation ?? 1);
  const runId = `ecsr_${randomUUID().replaceAll("-", "")}`;
  const lockToken = randomUUID().replaceAll("-", "");
  const claimed = await sql.query<{ id: string }>(`
    update enterprise_catalog_connections
       set sync_lock_token=$2,
           sync_lock_expires_at=now()+interval '5 minutes',
           last_sync_started_at=now(),
           last_sync_error=null,
           updated_at=now()
     where id=$1
       and status='active'
       and (sync_lock_token is null or sync_lock_expires_at < now())
     returning id`, [connection.id, lockToken]);
  if (!claimed[0]) throw new Error("Enterprise catalog sync already in progress");

  await sql.query(`insert into enterprise_catalog_sync_runs(id,connection_id,merchant_id,status,source,generation) values($1,$2,$3,'running',$4,$5)`, [runId, connection.id, input.merchantId, source, generation]);

  try {
    let pages = 0;
    let receivedCount = 0;
    let upserted = 0;
    let errors = 0;
    let lastLeaseRenewalAt = Date.now();
    const seenExternalProducts = new Set<string>();
    const configuredWriteBatch = Number(process.env.ELEMARKET_ENTERPRISE_SYNC_WRITE_BATCH_SIZE ?? "100");
    const batchSize = Number.isFinite(configuredWriteBatch)
      ? Math.min(Math.max(Math.trunc(configuredWriteBatch), 25), 500)
      : 100;

    const upsertBatch = async (batch: EnterpriseCatalogRecord[]): Promise<{ upserted: number; errors: number }> => {
      if (!batch.length) return { upserted: 0, errors: 0 };
      // jsonb_to_recordset matches JSON object keys exactly. Keep names in
      // sync with SQL columns instead of relying on camelCase conversion.
      const payload = batch.map((record) => {
        const productId = `prod_ext_${createHash("sha256").update(`${input.merchantId}:${record.id}`).digest("hex").slice(0, 40)}`;
        const payloadHash = createHash("sha256").update(JSON.stringify(record.raw)).digest("hex");
        return {
          product_id: productId,
          item_id: `eci_${randomUUID().replaceAll("-", "")}`,
          external_product_id: record.id,
          external_sku: record.sku ?? null,
          name: record.name,
          category: record.category,
          subcategory: record.subcategory ?? null,
          brand: record.brand ?? null,
          model: record.model ?? null,
          sku: record.sku ?? record.id,
          image_path: record.image ?? null,
          attributes: { ...record.attributes, enterpriseExternalId: record.id, enterprisePayloadHash: payloadHash },
          warranty_months: record.warrantyMonths ?? null,
          price: record.price,
          stock: record.stock,
          description: record.description ?? "",
          payload_hash: payloadHash,
          raw: record.raw,
        };
      });
      try {
        // Single parameterized SQL command: the PostgreSQL extended protocol
        // rejects multiple semicolon-separated statements with $ parameters.
        // A live lease fences a superseded sync before it can mutate products.
        const result = await sql.query<{ products_upserted: number; items_upserted: number }>(`
          with live_lease as (
            select id from enterprise_catalog_connections
             where id=$3 and merchant_id=$2 and sync_lock_token=$5 and sync_lock_expires_at>now()
          ),
          input as (select * from jsonb_to_recordset($1::jsonb) as x(
            product_id text, item_id text, external_product_id text, external_sku text, name text, category text,
            subcategory text, brand text, model text, sku text, image_path text, attributes jsonb, warranty_months integer,
            price numeric, stock integer, description text, payload_hash text, raw jsonb
          )),
          saved_products as (
            insert into products(
              id,merchant_id,name,category,subcategory,brand,model,sku,condition,attributes,warranty_months,
              fulfillment_type,status,returnable,listing_type,price,currency,stock,description,image_path,catalog_source,
              external_product_id,external_sku,external_updated_at,catalog_synced_at,published_at
            )
            select product_id,$2,name,category,subcategory,brand,model,sku,'new',attributes,warranty_months,
                   'delivery','active',true,'product',price,'GHS',stock,description,image_path,'enterprise_api',
                   external_product_id,external_sku,now(),now(),now()
              from input where exists(select 1 from live_lease)
            on conflict(id) do update set
              name=excluded.name,category=excluded.category,subcategory=excluded.subcategory,brand=excluded.brand,model=excluded.model,
              sku=excluded.sku,image_path=excluded.image_path,attributes=excluded.attributes,warranty_months=excluded.warranty_months,
              price=excluded.price,currency=excluded.currency,stock=excluded.stock,description=excluded.description,
              status='active',catalog_source='enterprise_api',external_product_id=excluded.external_product_id,
              external_sku=excluded.external_sku,external_updated_at=now(),catalog_synced_at=now(),updated_at=now()
            where products.merchant_id=$2 and products.catalog_source='enterprise_api'
            returning id
          ),
          saved_items as (
            insert into enterprise_catalog_items(
              id,connection_id,merchant_id,external_product_id,external_sku,payload_hash,payload,
              last_seen_at,last_synced_at,sync_generation,validation_status,validation_error
            )
            select item_id,$3,$2,external_product_id,external_sku,payload_hash,raw,now(),now(),$4,'valid',null
              from input where exists(select 1 from live_lease)
            on conflict(connection_id,external_product_id) do update set
              external_sku=excluded.external_sku,payload_hash=excluded.payload_hash,payload=excluded.payload,
              last_seen_at=now(),last_synced_at=now(),sync_generation=excluded.sync_generation,
              validation_status=excluded.validation_status,validation_error=excluded.validation_error
            returning id
          )
          select (select count(*)::int from saved_products) as products_upserted,
                 (select count(*)::int from saved_items) as items_upserted
        `, [JSON.stringify(payload), input.merchantId, connection.id, generation, lockToken]);
        if (Number(result[0]?.products_upserted) !== batch.length || Number(result[0]?.items_upserted) !== batch.length) {
          throw new Error("Enterprise catalog batch not fully committed; sync lease or product ownership conflict");
        }
        return { upserted: batch.length, errors: 0 };
      } catch (error) {
        if (error instanceof Error && error.message.includes("sync lease or product ownership conflict")) throw error;
        // Isolate a malformed/constraint-breaking record without returning to
        // the old one-SQL-statement-per-record hot path for healthy batches.
        if (batch.length === 1) return { upserted: 0, errors: 1 };
        const midpoint = Math.ceil(batch.length / 2);
        const left = await upsertBatch(batch.slice(0, midpoint));
        const right = await upsertBatch(batch.slice(midpoint));
        return { upserted: left.upserted + right.upserted, errors: left.errors + right.errors };
      }
    };

    for await (const page of fetchCatalogPages(connection)) {
      pages = page.page;
      receivedCount += page.records.length;
      for (const record of page.records) {
        if (seenExternalProducts.has(record.id)) throw new Error("Enterprise catalog contains a duplicate external product ID");
        seenExternalProducts.add(record.id);
      }
      for (let offset = 0; offset < page.records.length; offset += batchSize) {
        if (Date.now() - lastLeaseRenewalAt >= 60_000) {
          const lease = await sql.query<{ id: string }>(`
            update enterprise_catalog_connections
               set sync_lock_expires_at=now()+interval '5 minutes', updated_at=now()
             where id=$1 and sync_lock_token=$2 and sync_lock_expires_at>now()
             returning id`, [connection.id, lockToken]);
          if (!lease[0]) throw new Error("Enterprise catalog sync lease lost");
          lastLeaseRenewalAt = Date.now();
        }
        const result = await upsertBatch(page.records.slice(offset, offset + batchSize));
        upserted += result.upserted;
        errors += result.errors;
      }
    }

    let deactivated = 0;
    if (connection.sync_mode === "snapshot" && errors === 0) {
      // An empty upstream response is frequently an API failure, not a genuine
      // removal of every item. Require an explicit operator workflow for an
      // intentionally empty catalog instead of mass-archiving on a sync.
      if (receivedCount === 0) throw new Error("Refusing empty enterprise snapshot; existing products preserved");
      const ownedLease = await sql.query<{ id: string }>(`
        update enterprise_catalog_connections
           set sync_lock_expires_at=now()+interval '5 minutes',updated_at=now()
         where id=$1 and sync_lock_token=$2 and sync_lock_expires_at>now()
         returning id`, [connection.id, lockToken]);
      if (!ownedLease[0]) throw new Error("Enterprise catalog sync lease lost before snapshot archival");
      const candidates = await sql.query<{ total: number; missing: number }>(`
        select count(*)::int as total,
               count(*) filter (where not exists (
                 select 1 from enterprise_catalog_items current_item
                  where current_item.connection_id=$2 and current_item.external_product_id=p.external_product_id
                    and current_item.sync_generation=$3
               ))::int as missing
          from products p
         where p.merchant_id=$1 and p.catalog_source='enterprise_api'
           and p.external_product_id is not null and p.status <> 'archived'
           and exists (select 1 from enterprise_catalog_items owned_item
                        where owned_item.connection_id=$2 and owned_item.external_product_id=p.external_product_id)
      `, [input.merchantId, connection.id, generation]);
      const previousTotal=Number(candidates[0]?.total ?? 0);
      const wouldArchive=Number(candidates[0]?.missing ?? 0);
      if (wouldArchive >= 10 && previousTotal > 0 && wouldArchive / previousTotal > 0.25) {
        throw new Error("Enterprise snapshot would archive over 25% of products; manual reconciliation required");
      }
      const rows = await sql.query<{ count: number }>(`
        with archived as (
          update products p
             set stock=0,status='archived',updated_at=now()
           where p.merchant_id=$1
             and p.catalog_source='enterprise_api'
             and p.external_product_id is not null and p.status <> 'archived'
             and exists (select 1 from enterprise_catalog_items owned_item
                         where owned_item.connection_id=$2 and owned_item.external_product_id=p.external_product_id)
             and not exists (
               select 1 from enterprise_catalog_items i
                where i.connection_id=$2
                  and i.external_product_id=p.external_product_id
                  and i.sync_generation = $3
             )
           returning 1
        ) select count(*)::int as count from archived`, [input.merchantId, connection.id, generation]);
      deactivated = Number(rows[0]?.count ?? 0);
    }
    const status = errors ? (upserted ? "partial" : "failed") : "success";
    await sql.query(`update enterprise_catalog_sync_runs set status=$1,completed_at=now(),received_count=$2,upserted_count=$3,deactivated_count=$4,error_count=$5,error_message=$6,cursor_pages=$8,generation=$9 where id=$7`, [status,receivedCount,upserted,deactivated,errors,errors ? `${errors} item(s) failed validation or upsert` : null,runId, pages, generation]);
    await sql.query(`update enterprise_catalog_connections
       set last_sync_completed_at=now(),
           last_inventory_sync_at=case when $1='success' then now() else last_inventory_sync_at end,
           last_sync_status=$1,last_sync_count=$2,last_sync_error=$3,
           status='active',
           consecutive_sync_failures=case when $1<>'success' then consecutive_sync_failures+1 else 0 end,
           next_sync_at=case when $1<>'success' then now()+least(interval '1 hour',interval '30 seconds' * power(2,least(consecutive_sync_failures,7))) else null end,
           sync_lock_token=null,sync_lock_expires_at=null,updated_at=now()
     where id=$4 and sync_lock_token=$5`, [status,upserted,errors ? `${errors} item(s) failed validation or upsert` : null,connection.id,lockToken]);
    return { runId, status, generation, pages, receivedCount: receivedCount, upsertedCount: upserted, deactivatedCount: deactivated, errorCount: errors };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Enterprise catalog sync failed";
    await sql.query(`update enterprise_catalog_sync_runs set status='failed',completed_at=now(),error_count=1,error_message=$1 where id=$2`, [message.slice(0, 2000),runId]);
    await sql.query(`update enterprise_catalog_connections
       set last_sync_status='failed',last_sync_error=$1,status='active',
           consecutive_sync_failures=consecutive_sync_failures+1,
           next_sync_at=now()+least(interval '1 hour',interval '30 seconds' * power(2,least(consecutive_sync_failures,7))),
           sync_lock_token=null,sync_lock_expires_at=null,updated_at=now()
     where id=$2 and sync_lock_token=$3`, [message.slice(0, 2000),connection.id,lockToken]);
    throw error;
  }
}

export async function saveEnterpriseCatalogConnection(input: {
  merchantId: string;
  endpointUrl: string;
  authType: "none" | "bearer" | "api_key" | "basic";
  credentials?: Credentials;
  responsePath?: string;
  fieldMapping: EnterpriseCatalogFieldMapping;
  syncMode?: "upsert_only" | "snapshot";
  webhookEnabled?: boolean;
  webhookSecret?: string;
  pageSize?: number;
  cursorParam?: string;
  cursorPath?: string;
  inventoryStaleAfterSeconds?: number;
  orderEndpointUrl?: string;
  orderWebhookSecret?: string;
}) {
  await validateEndpoint(input.endpointUrl);
  if (input.orderEndpointUrl) await validateEndpoint(input.orderEndpointUrl);
  const mapping = fieldMappingSchema.parse(input.fieldMapping);
  const sql = await getSql();
  const merchantRows = await sql.query<{ settlement_model: string; catalog_source: string }>(`select settlement_model,catalog_source from merchants where id=$1`, [input.merchantId]);
  if (!merchantRows[0] || merchantRows[0].settlement_model !== "enterprise_direct" || merchantRows[0].catalog_source !== "enterprise_api") throw new Error("Merchant is not configured for enterprise API catalog");

  const existingRows = await sql.query<{
    auth_type: "none" | "bearer" | "api_key" | "basic";
    credentials_encrypted: string | null;
    webhook_enabled: boolean;
    webhook_secret_encrypted: string | null;
    order_webhook_secret_encrypted: string | null;
    order_endpoint_url: string | null;
  }>(`select auth_type,credentials_encrypted,webhook_enabled,webhook_secret_encrypted,order_webhook_secret_encrypted,order_endpoint_url from enterprise_catalog_connections where merchant_id=$1`, [input.merchantId]);
  const existing = existingRows[0];
  const authTypeChanged = Boolean(existing && existing.auth_type !== input.authType);
  if (input.authType !== "none" && authTypeChanged && !input.credentials) {
    throw new Error("New credentials are required when changing enterprise authentication type");
  }
  if (input.authType === "bearer" && input.credentials && !input.credentials.token) throw new Error("Bearer token is required");
  if (input.authType === "api_key" && input.credentials && !input.credentials.apiKey) throw new Error("API key is required");
  if (input.authType === "basic" && input.credentials && (!input.credentials.username || !input.credentials.password)) throw new Error("Basic username and password are required");
  if (input.authType !== "none" && !input.credentials && (!existing || existing.auth_type !== input.authType)) {
    throw new Error("New credentials are required for this authentication mode");
  }
  if (input.webhookEnabled && !input.webhookSecret && (!existing?.webhook_secret_encrypted || !existing.webhook_enabled)) {
    throw new Error("Enterprise catalog webhook secret is required when enabling webhooks");
  }
  if (input.webhookSecret && input.webhookSecret.length < 32) throw new Error("Enterprise catalog webhook secret must be at least 32 characters");
  if (input.orderWebhookSecret && input.orderWebhookSecret.length < 32) throw new Error("Enterprise order webhook secret must be at least 32 characters");

  const id = `ecc_${randomUUID().replaceAll("-", "")}`;
  const encryptedCredentials = input.authType === "none"
    ? null
    : input.credentials
      ? encryptMerchantSensitiveData(input.credentials)
      : existing?.credentials_encrypted ?? null;
  // Never carry credentials across an authentication-mode transition.
  // If the mode changes, the caller must provide credentials for the new mode.
  if (authTypeChanged && input.authType !== "none" && !input.credentials) {
    throw new Error("Authentication mode changed without replacement credentials");
  }
  const encryptedWebhookSecret = input.webhookEnabled
    ? (input.webhookSecret ? encryptMerchantSensitiveData({ secret: input.webhookSecret }) : existing?.webhook_secret_encrypted ?? null)
    : null;
  const encryptedOrderWebhookSecret = input.orderWebhookSecret
    ? encryptMerchantSensitiveData({ secret: input.orderWebhookSecret })
    : existing?.order_webhook_secret_encrypted ?? null;
  const orderEndpointUrl = input.orderEndpointUrl ?? existing?.order_endpoint_url ?? null;
  await sql.query(`
    insert into enterprise_catalog_connections(id,merchant_id,endpoint_url,auth_type,credentials_encrypted,response_path,field_mapping,sync_mode,webhook_enabled,webhook_secret_encrypted,page_size,cursor_param,cursor_path,inventory_stale_after_seconds,order_endpoint_url,order_webhook_secret_encrypted,status,updated_at)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,'active',now())
    on conflict(merchant_id) do update set endpoint_url=excluded.endpoint_url,auth_type=excluded.auth_type,credentials_encrypted=excluded.credentials_encrypted,response_path=excluded.response_path,field_mapping=excluded.field_mapping,sync_mode=excluded.sync_mode,webhook_enabled=excluded.webhook_enabled,webhook_secret_encrypted=excluded.webhook_secret_encrypted,page_size=excluded.page_size,cursor_param=excluded.cursor_param,cursor_path=excluded.cursor_path,inventory_stale_after_seconds=excluded.inventory_stale_after_seconds,order_endpoint_url=excluded.order_endpoint_url,order_webhook_secret_encrypted=excluded.order_webhook_secret_encrypted,status='active',updated_at=now()
  `, [id,input.merchantId,input.endpointUrl,input.authType,encryptedCredentials,input.responsePath ?? "products",JSON.stringify(mapping),input.syncMode ?? "upsert_only",Boolean(input.webhookEnabled),encryptedWebhookSecret,input.pageSize ?? 250,input.cursorParam ?? "cursor",input.cursorPath ?? null,input.inventoryStaleAfterSeconds ?? 900,orderEndpointUrl,encryptedOrderWebhookSecret]);
  return { configured: true };
}

export async function verifyEnterpriseWebhook(input: { merchantId: string; rawBody: string; signature: string | null; timestamp: string | null }) {
  const sql = await getSql();
  const rows = await sql.query<{ webhook_secret_encrypted: string | null; webhook_enabled: boolean }>(`
    select c.webhook_secret_encrypted,c.webhook_enabled
      from enterprise_catalog_connections c
      join merchants m on m.id=c.merchant_id
     where c.merchant_id=$1 and c.status='active'
       and m.status='active' and m.verified=true
       and m.catalog_source='enterprise_api' and m.settlement_model='enterprise_direct'`, [input.merchantId]);
  const row = rows[0];
  if (!row?.webhook_enabled || !row.webhook_secret_encrypted || !input.signature || !input.timestamp) return false;
  const timestamp = input.timestamp.trim();
  if (!/^\d{10,13}$/.test(timestamp)) return false;
  const millis = timestamp.length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
  if (!Number.isSafeInteger(millis) || Math.abs(Date.now() - millis) > 5 * 60 * 1000) return false;
  const { secret } = decryptMerchantSensitiveData<{ secret: string }>(row.webhook_secret_encrypted);
  const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}.${input.rawBody}`)));
  const provided = input.signature.trim().toLowerCase().replace(/^sha256=/, "");
  if (!/^[a-f0-9]{64}$/.test(provided)) return false;
  const bytes = Uint8Array.from(provided.match(/.{2}/g)!.map((v) => Number.parseInt(v,16)));
  if (bytes.length !== expected.length) return false;
  let diff = 0; for (let i=0;i<bytes.length;i++) diff |= bytes[i] ^ expected[i];
  return diff === 0;
}

export async function syncAllEnterpriseCatalogs() {
  const sql = await getSql();
  const configuredBatchSize = Number(process.env.ELEMARKET_ENTERPRISE_SYNC_BATCH_SIZE ?? "10");
  const batchSize = Number.isFinite(configuredBatchSize)
    ? Math.min(Math.max(Math.trunc(configuredBatchSize), 1), 25)
    : 10;
  // Process the stalest connections first and bound each serverless invocation.
  // A cron invocation must never attempt to synchronously synchronize every
  // enterprise merchant in the system.
  const rows = await sql.query<{ merchant_id: string }>(
    `select merchant_id
       from enterprise_catalog_connections
      where status='active'
        and (next_sync_at is null or next_sync_at<=now())
      order by next_sync_at asc nulls first,last_sync_started_at asc nulls first, merchant_id asc
      limit $1`,
    [batchSize],
  );
  const results: Array<{ merchantId: string; status: string }> = [];
  for (const row of rows) {
    try {
      const result = await syncEnterpriseCatalog({ merchantId: row.merchant_id, source: "scheduled" });
      results.push({ merchantId: row.merchant_id, status: result.status });
    } catch (error) {
      // Never return upstream/provider/database exception text from this internal
      // control plane. The detailed error is already persisted for operators.
      console.error("[enterprise-catalog-sync] merchant sync failed", {
        merchantId: row.merchant_id,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      results.push({ merchantId: row.merchant_id, status: "failed" });
    }
  }
  return results;
}
