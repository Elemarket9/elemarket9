import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { decryptMerchantSensitiveData, encryptMerchantSensitiveData } from "@/lib/security/merchant-sensitive.server";
import { assertPublicHttpsEndpoint } from "@/lib/security/ssrf.server";
import { pinnedGet } from "@/modules/merchants/internal/enterprise-catalog.server";
import { CATEGORY_KEYS, isValidSubcategory } from "@/modules/shared/public/categories";

export type BrandConnectorType = "rest_json" | "csv" | "xml" | "erp_oms_wms" | "manual_feed";
export type BrandEnvironment = "sandbox" | "production";
export type BrandScope = "catalog:read" | "inventory:read" | "price:read" | "orders:write" | "fulfillment:read" | "returns:read" | "warranty:read";

export interface BrandFeedRecord {
  externalProductId: string;
  externalSku?: string;
  name: string;
  description?: string;
  brand?: string;
  category: string;
  subcategory?: string;
  model?: string;
  price: number;
  currency?: string;
  stock: number;
  imageUrl?: string;
  condition?: string;
  warranty?: string;
  gtin?: string;
  mpn?: string;
  externalVersion?: number;
  attributes?: Record<string, unknown>;
}

const ALLOWED_SCOPES = new Set<BrandScope>([
  "catalog:read", "inventory:read", "price:read", "orders:write",
  "fulfillment:read", "returns:read", "warranty:read",
]);

const MAX_FEED_BYTES = 10 * 1024 * 1024;
const MAX_FEED_RECORDS = 10_000;
const MAX_CSV_COLUMNS = 80;
const MAX_CSV_FIELD_BYTES = 8 * 1024;
const MAX_CSV_ROW_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_KEYS = 200;
const MAX_ATTRIBUTES_BYTES = 64 * 1024;
const MAX_PRICE_GHS = 100_000_000;
const MAX_STOCK = 1_000_000;
const ALLOWED_WEBHOOK_EVENTS = new Set([
  "catalog.changed", "inventory.changed", "price.changed", "order.acknowledged",
  "order.status_changed", "fulfillment.updated", "return.updated", "warranty.updated",
]);

function assertSafeJson(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) throw new Error("Integration payload nesting exceeds limit");
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_KEYS) throw new Error("Integration array exceeds limit");
    for (const item of value) assertSafeJson(item, depth + 1);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_JSON_KEYS) throw new Error("Integration object exceeds limit");
  for (const [key, child] of entries) {
    if (key.length > 160 || /^(?:__proto__|constructor|prototype)$/.test(key)) throw new Error("Invalid integration field name");
    assertSafeJson(child, depth + 1);
  }
}

function parseMoney(value: unknown): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(text)) throw new Error("Invalid integration price");
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_PRICE_GHS * 100) throw new Error("Integration price is outside allowed range");
  return cents / 100;
}

function validateExternalImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    if (url.hostname.length > 253 || url.search.length > 1024 || url.pathname.length > 2048) return undefined;
    return url.toString().slice(0, 2000);
  } catch {
    return undefined;
  }
}

function validateFieldMapping(aliases: Record<string, string>): Record<string, string> {
  const allowed = new Set(["externalProductId","externalSku","name","description","brand","category","subcategory","model","price","currency","stock","imageUrl","condition","warranty","gtin","mpn","externalVersion","attributes"]);
  const out: Record<string,string> = {};
  for (const [key, value] of Object.entries(aliases ?? {})) {
    if (!allowed.has(key) || typeof value !== "string" || value.trim().length < 1 || value.length > 200) throw new Error("Invalid integration field mapping");
    out[key] = value.trim();
  }
  return out;
}

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v ? v.slice(0, max) : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function assertLiveBrandAuthorization(sql: Awaited<ReturnType<typeof getSql>>, connectionId: string) {
  const rows = await sql.query<{merchant_id:string; brand_id:string; authorization_id:string|null; status:string; expires_at:string|null}>(`
    select c.merchant_id,c.brand_id,c.authorization_id,c.status,a.status as authorization_status,a.expires_at
      from brand_integration_connections c
      left join merchant_brand_authorizations a on a.id=c.authorization_id
     where c.id=$1
  `,[connectionId]);
  const c=rows[0];
  if(!c || c.status!=='active') throw new Error('Integration connection is not active');
  if(!c.authorization_id) {
    const ok=await sql.query(`select 1 from merchant_brand_authorizations where merchant_id=$1 and brand_id=$2 and status='verified' and (expires_at is null or expires_at>now()) limit 1`,[c.merchant_id,c.brand_id]);
    if(!ok[0]) {
      await sql.query(`update brand_integration_connections set status='revoked',updated_at=now(),last_error='Brand authorization is expired or revoked' where id=$1 and status<>'revoked'`,[connectionId]);
      throw new Error('Brand authorization is expired or revoked');
    }
  } else if((c as any).authorization_status!=='verified' || ((c as any).expires_at && new Date((c as any).expires_at).getTime()<=Date.now())) {
    await sql.query(`update brand_integration_connections set status='revoked',updated_at=now(),last_error='Brand authorization expired or revoked' where id=$1 and status<>'revoked'`,[connectionId]);
    throw new Error('Brand authorization is expired or revoked');
  }
  return c;
}

function csvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let rowBytes = 0;
  const pushField = () => {
    if (Buffer.byteLength(field, "utf8") > MAX_CSV_FIELD_BYTES) throw new Error("CSV field exceeds limit");
    row.push(field); field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.length > MAX_CSV_COLUMNS) throw new Error("Too many CSV columns");
    rows.push(row);
    if (rows.length > MAX_FEED_RECORDS + 1) throw new Error("CSV feed exceeds record limit");
    row = []; rowBytes = 0;
  };
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    rowBytes += Buffer.byteLength(ch, "utf8");
    if (rowBytes > MAX_CSV_ROW_BYTES) throw new Error("CSV row exceeds limit");
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i += 1; rowBytes += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') pushRow();
    else if (ch !== '\r') field += ch;
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  if (field.length || row.length) pushRow();
  return rows;
}

function parseBoundedXml(input: string): Record<string, unknown>[] {
  if (Buffer.byteLength(input, "utf8") > MAX_FEED_BYTES) throw new Error("Integration feed exceeds 10 MB limit");
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(input)) throw new Error("XML DTD/entities/CDATA are not allowed");
  const records: Record<string, unknown>[] = [];
  const stack: string[] = [];
  const current: Record<string, unknown>[] = [];
  const tagRe = /<\/?([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[^<>]*?)?\/?>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let tags = 0;
  while ((m = tagRe.exec(input))) {
    const token = m[0];
    if (token.startsWith("<?") || token.startsWith("<!--")) continue;
    if (token.startsWith("<")) {
      tags += 1; if (tags > 100_000) throw new Error("XML tag limit exceeded");
      const closing = /^<\//.test(token);
      const selfClosing = /\/\s*>$/.test(token);
      const name = m[1];
      if (!name) throw new Error("Invalid XML tag");
      if (closing) {
        if (stack.pop() !== name) throw new Error("Malformed XML feed");
        if (name.toLowerCase() === "product") {
          const product = current.pop();
          if (product) records.push(product);
          if (records.length > MAX_FEED_RECORDS) throw new Error("XML feed exceeds record limit");
        }
      } else {
        if (stack.length >= 32) throw new Error("XML nesting exceeds limit");
        stack.push(name);
        if (name.toLowerCase() === "product") current.push(Object.create(null));
        if (selfClosing) {
          stack.pop();
          if (name.toLowerCase() === "product") { const product = current.pop(); if (product) records.push(product); }
        }
      }
    } else if (stack.length && current.length) {
      const text = m[2]?.trim();
      if (!text) continue;
      if (Buffer.byteLength(text, "utf8") > MAX_CSV_FIELD_BYTES) throw new Error("XML field exceeds limit");
      const name = stack[stack.length - 1];
      if (stack.length >= 2 && stack[stack.length - 2].toLowerCase() === "product") {
        const target = current[current.length - 1];
        const prior = target[name];
        target[name] = prior === undefined ? text : `${String(prior)} ${text}`;
      }
    }
  }
  if (stack.length || !records.length) throw new Error("No supported <product> records found in XML feed");
  return records;
}


function asRecord(raw: Record<string, unknown>, aliases: Record<string, string>): BrandFeedRecord {
  const safeAliases = validateFieldMapping(aliases);
  const pick = (key: string) => raw[safeAliases[key] ?? key] ?? raw[key];
  const externalProductId = clean(pick("externalProductId"), 160);
  const name = clean(pick("name"), 200);
  const category = clean(pick("category"), 120);
  if (!category || !(CATEGORY_KEYS as readonly string[]).includes(category)) throw new Error("Invalid integration category");
  const subcategory = clean(pick("subcategory"), 120);
  if (subcategory && !isValidSubcategory(category, subcategory)) throw new Error("Invalid integration subcategory");
  const price = parseMoney(pick("price"));
  const stock = Number(pick("stock"));
  if (!externalProductId || !name || !category || !Number.isSafeInteger(stock) || stock < 0 || stock > MAX_STOCK) throw new Error("Invalid integration product record");
  const currency = clean(pick("currency"), 3)?.toUpperCase() ?? "GHS";
  if (currency !== "GHS") throw new Error("ELEMARKET marketplace currency is GHS");
  const attributesRaw = pick("attributes");
  let attributes: Record<string, unknown> | undefined;
  if (attributesRaw !== undefined) {
    if (typeof attributesRaw !== "object" || attributesRaw === null || Array.isArray(attributesRaw)) throw new Error("Invalid integration attributes");
    assertSafeJson(attributesRaw);
    if (Buffer.byteLength(JSON.stringify(attributesRaw), "utf8") > MAX_ATTRIBUTES_BYTES) throw new Error("Integration attributes exceed limit");
    attributes = attributesRaw as Record<string, unknown>;
  }
  const externalVersionRaw = pick("externalVersion");
  let externalVersion: number | undefined;
  if (externalVersionRaw !== undefined && externalVersionRaw !== "") {
    const n = Number(externalVersionRaw);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid integration version");
    externalVersion = n;
  }
  return {
    externalProductId, externalSku: clean(pick("externalSku"), 160), name,
    description: clean(pick("description"), 4000), brand: clean(pick("brand"), 120),
    category, subcategory, model: clean(pick("model"), 160),
    price, currency, stock, imageUrl: validateExternalImageUrl(clean(pick("imageUrl"), 2000)),
    condition: clean(pick("condition"), 80), warranty: clean(pick("warranty"), 500),
    gtin: clean(pick("gtin"), 64), mpn: clean(pick("mpn"), 64), externalVersion, attributes,
  };
}


export function parseBrandFeed(body: string, type: "csv" | "xml", aliases: Record<string, string> = {}): BrandFeedRecord[] {
  if (Buffer.byteLength(body, "utf8") > MAX_FEED_BYTES) throw new Error("Integration feed exceeds 10 MB limit");
  const safeAliases = validateFieldMapping(aliases);
  if (type === "csv") {
    const rows = csvRows(body);
    if (!rows.length) return [];
    const headers = rows.shift()!.map((h) => h.trim());
    if (!headers.length || headers.length > MAX_CSV_COLUMNS || headers.some((h) => !h || h.length > 200)) throw new Error("Invalid CSV headers");
    if (new Set(headers).size !== headers.length) throw new Error("Duplicate CSV headers");
    return rows.filter((r) => r.some(Boolean)).map((r) => asRecord(Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])), safeAliases));
  }
  return parseBoundedXml(body).map((record) => asRecord(record, safeAliases));
}


async function loadBrandIntegrationCredentials(sql: Awaited<ReturnType<typeof getSql>>, connectionId: string) {
  const rows=await sql.query<{credentials_encrypted:string|null;webhook_secret_encrypted:string|null}>(`select credentials_encrypted,webhook_secret_encrypted from brand_integration_credentials where connection_id=$1 and status='active' order by activated_at desc limit 1`,[connectionId]);
  if(rows[0]) return {credentials:rows[0].credentials_encrypted?decryptMerchantSensitiveData<Record<string,string>>(rows[0].credentials_encrypted):{},webhookSecret:rows[0].webhook_secret_encrypted?decryptMerchantSensitiveData<{secret:string}>(rows[0].webhook_secret_encrypted).secret:null};
  const legacy=await sql.query<{credentials_encrypted:string|null;webhook_secret_encrypted:string|null}>(`select credentials_encrypted,webhook_secret_encrypted from brand_integration_connections where id=$1`,[connectionId]);
  return {credentials:legacy[0]?.credentials_encrypted?decryptMerchantSensitiveData<Record<string,string>>(legacy[0].credentials_encrypted):{},webhookSecret:legacy[0]?.webhook_secret_encrypted?decryptMerchantSensitiveData<{secret:string}>(legacy[0].webhook_secret_encrypted).secret:null};
}

export async function createBrandIntegrationConnection(input: {
  merchantId: string; organizationId?: string; locationId?: string; brandId: string; authorizationId?: string;
  name: string; connectorType: BrandConnectorType; environment?: BrandEnvironment; baseUrl?: string;
  authType?: "none" | "bearer" | "api_key" | "basic" | "hmac";
  credentials?: Record<string, string>; scopes: BrandScope[]; capabilities?: string[];
  fieldMapping?: Record<string, string>; webhookSecret?: string; staleAfterSeconds?: number;
}) {
  const sql = await getSql();
  const scopes = [...new Set(input.scopes)].filter((s) => ALLOWED_SCOPES.has(s));
  if (scopes.length !== input.scopes.length || !scopes.length) throw new Error("Invalid integration scopes");
  if (input.name.trim().length < 2 || input.name.trim().length > 160) throw new Error("Invalid integration name");
  const fieldMapping = validateFieldMapping(input.fieldMapping ?? {});
  if (input.baseUrl && input.connectorType !== "csv" && input.connectorType !== "manual_feed") await assertPublicHttpsEndpoint(input.baseUrl);
  if (input.authType === "hmac" && !input.credentials?.secret) throw new Error("HMAC integrations require credentials.secret");
  if (input.credentials && Buffer.byteLength(JSON.stringify(input.credentials), "utf8") > 64 * 1024) throw new Error("Integration credentials exceed limit");
  if (input.webhookSecret && (input.webhookSecret.length < 32 || input.webhookSecret.length > 512)) throw new Error("Webhook secret must be 32-512 characters");
  const id = `big_${randomUUID().replaceAll("-", "")}`;
  const encrypted = input.credentials ? encryptMerchantSensitiveData(input.credentials) : null;
  const webhook = input.webhookSecret ? encryptMerchantSensitiveData({ secret: input.webhookSecret }) : null;
  await sql.query(`insert into brand_integration_connections(id,merchant_id,organization_id,location_id,brand_id,authorization_id,name,connector_type,environment,base_url,auth_type,credentials_encrypted,scopes,capabilities,field_mapping,webhook_enabled,webhook_secret_encrypted,stale_after_seconds) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [
    id,input.merchantId,input.organizationId ?? null,input.locationId ?? null,input.brandId,input.authorizationId ?? null,input.name.trim(),input.connectorType,input.environment ?? "sandbox",input.baseUrl ?? null,input.authType ?? "none",encrypted,scopes,input.capabilities ?? [],JSON.stringify(fieldMapping),Boolean(input.webhookSecret),webhook,Math.min(Math.max(Math.trunc(input.staleAfterSeconds ?? 900),60),604800),
  ]);
  if (encrypted || webhook) await sql.query(`insert into brand_integration_credentials(id,connection_id,credentials_encrypted,webhook_secret_encrypted,status,activated_at) values($1,$2,$3,$4,'active',now())`,[`bicred_${randomUUID().replaceAll("-","")}`,id,encrypted,webhook]);
  return { id, environment: input.environment ?? "sandbox", scopes };
}

export async function rotateBrandIntegrationCredentials(input: { connectionId: string; credentials?: Record<string,string>; webhookSecret?: string }) {
  const sql = await getSql();
  await assertLiveBrandAuthorization(sql,input.connectionId);
  const rows = await sql.query<{ merchant_id: string; credentials_encrypted:string|null; webhook_secret_encrypted:string|null }>(`select merchant_id,credentials_encrypted,webhook_secret_encrypted from brand_integration_connections where id=$1 for update`, [input.connectionId]);
  if (!rows[0]) throw new Error("Integration connection not found");
  if (!input.credentials && !input.webhookSecret) throw new Error("No credentials supplied for rotation");
  if (input.webhookSecret && (input.webhookSecret.length < 32 || input.webhookSecret.length > 512)) throw new Error("Webhook secret must be 32-512 characters");
  const current = await loadBrandIntegrationCredentials(sql,input.connectionId);
  const credentials = input.credentials ?? current.credentials;
  const webhookSecret = input.webhookSecret ?? current.webhookSecret;
  const encrypted = encryptMerchantSensitiveData(credentials);
  const webhook = webhookSecret ? encryptMerchantSensitiveData({secret:webhookSecret}) : null;
  await sql.query(`update brand_integration_credentials set status='retired',retired_at=now() where connection_id=$1 and status='active'`,[input.connectionId]);
  await sql.query(`insert into brand_integration_credentials(id,connection_id,credentials_encrypted,webhook_secret_encrypted,status,activated_at) values($1,$2,$3,$4,'active',now())`,[`bicred_${randomUUID().replaceAll("-","")}`,input.connectionId,encrypted,webhook]);
  await sql.query(`update brand_integration_connections set credentials_encrypted=$2,webhook_secret_encrypted=$3,updated_at=now() where id=$1`, [input.connectionId,encrypted,webhook]);
  return { ok: true };
}

export async function ingestBrandFeed(input: { connectionId: string; source: "manual" | "scheduled" | "webhook"; records: BrandFeedRecord[]; authoritativeSnapshot?: boolean }) {
  const sql = await getSql();
  if (input.records.length > MAX_FEED_RECORDS) throw new Error("Feed exceeds 10,000 records per batch");
  // Empty partner feeds are not evidence of intentional catalogue deletion.
  if (input.authoritativeSnapshot && input.records.length === 0) {
    throw new Error("Refusing empty brand/distributor snapshot; catalogue preserved");
  }
  const connectionRows = await sql.query<{ merchant_id:string; brand_id:string; status:string; field_mapping:Record<string,string>; sync_mode:string; location_id:string|null }>(`select merchant_id,brand_id,status,field_mapping,sync_mode,location_id from brand_integration_connections where id=$1 for update`, [input.connectionId]);
  const connection = connectionRows[0];
  if (!connection || connection.status !== "active") throw new Error("Integration connection is not active");
  await assertLiveBrandAuthorization(sql,input.connectionId);
  const runId = `bigr_${randomUUID().replaceAll("-","")}`;
  await sql.query(`insert into brand_integration_sync_runs(id,connection_id,merchant_id,source,authoritative_snapshot) values($1,$2,$3,$4,$5)`, [runId,input.connectionId,connection.merchant_id,input.source,Boolean(input.authoritativeSnapshot)]);
  let accepted=0,rejected=0,created=0,updated=0,staleRejected=0;
  const seen = new Set<string>();
  for (const record of input.records) {
    try {
      if (seen.has(record.externalProductId)) throw new Error("duplicate externalProductId in batch");
      seen.add(record.externalProductId);
      const result = await sql.query<{created:boolean; updated:boolean; stale_rejected:boolean}>(`select * from apply_brand_integration_record($1,$2,$3,$4)`,[input.connectionId,connection.merchant_id,connection.location_id,JSON.stringify(record)]);
      const r=result[0];
      if(r?.stale_rejected){ staleRejected++; continue; }
      if(r?.created) created++; else updated++;
      accepted++;
    } catch { rejected++; }
  }
  if(connection.sync_mode==='snapshot' && input.authoritativeSnapshot && (input.source==='manual' || input.source==='scheduled')) {
    if (rejected > 0) {
      await sql.query(`update brand_integration_sync_runs set status='failed',completed_at=now(),received_count=$2,accepted_count=$3,rejected_count=$4,error_message=$5 where id=$1`,[runId,input.records.length,accepted,rejected,'Incomplete snapshot cannot deactivate existing catalogue records']);
      throw new Error("Incomplete snapshot cannot deactivate existing catalogue records");
    }
    const removals = await sql.query<{total:number; missing:number}>(`
      select count(*)::int as total,
             count(*) filter (where last_seen_at < (select started_at from brand_integration_sync_runs where id=$2))::int as missing
        from brand_integration_product_map where connection_id=$1 and status='active'`,[input.connectionId,runId]);
    const total=Number(removals[0]?.total??0), missing=Number(removals[0]?.missing??0);
    if (missing >= 10 && total > 0 && missing / total > 0.25) {
      await sql.query(`update brand_integration_sync_runs set status='failed',completed_at=now(),received_count=$2,accepted_count=$3,rejected_count=$4,error_message=$5 where id=$1`,[runId,input.records.length,accepted,rejected,'Snapshot would remove more than 25% of brand offers']);
      throw new Error('Brand/distributor snapshot requires manual reconciliation before mass deactivation');
    }
    await sql.query(`update brand_integration_product_map set status='stale' where connection_id=$1 and last_seen_at < (select started_at from brand_integration_sync_runs where id=$2) and status='active'`,[input.connectionId,runId]);
    await sql.query(`update brand_integration_offers set status='stale',updated_at=now() where connection_id=$1 and last_seen_at < (select started_at from brand_integration_sync_runs where id=$2) and status='active'`,[input.connectionId,runId]);
    await sql.query(`update products p set status='suspended',stock=0 where p.catalog_source='enterprise_api' and p.merchant_id=(select merchant_id from brand_integration_connections where id=$1)
      and exists(select 1 from brand_integration_product_map mapped where mapped.connection_id=$1 and mapped.product_id=p.id)
      and not exists(select 1 from brand_integration_offers o where o.product_id=p.id and o.status='active')`,[input.connectionId]);
    await sql.query(`insert into brand_integration_reconciliation(id,connection_id,merchant_id,entity_type,entity_key,discrepancy_type,local_value,status) select 'bir_'||replace(gen_random_uuid()::text,'-',''),connection_id,merchant_id,'product',external_product_id,'missing_remote',jsonb_build_object('status',status),'open' from brand_integration_product_map where connection_id=$1 and status='stale' on conflict(connection_id,entity_type,entity_key,discrepancy_type) do nothing`,[input.connectionId]);
  }
  await sql.query(`update brand_integration_sync_runs set status=$1,completed_at=now(),received_count=$2,accepted_count=$3,rejected_count=$4,created_count=$5,updated_count=$6,stale_rejected_count=$7 where id=$8`, [rejected ? (accepted ? "partial" : "failed") : "success",input.records.length,accepted,rejected,created,updated,staleRejected,runId]);
  await sql.query(`update brand_integration_connections set last_sync_completed_at=now(),last_sync_status=$1,last_sync_count=$2,last_inventory_sync_at=case when $1 in ('success','partial') then now() else last_inventory_sync_at end,last_error=$3,updated_at=now() where id=$4`, [rejected ? (accepted ? "partial" : "failed") : "success",accepted,rejected ? `${rejected} record(s) rejected` : null,input.connectionId]);
  return { runId, received: input.records.length, accepted, rejected, created, updated, staleRejected };
}

export async function fetchAndSyncBrandConnection(input: { connectionId: string; source?: "scheduled" | "webhook" }) {
  const sql = await getSql();
  const rows = await sql.query<{ merchant_id:string; connector_type:BrandConnectorType; base_url:string|null; auth_type:string; credentials_encrypted:string|null; field_mapping:Record<string,string>; scopes:string[]; status:string; sync_mode:string; circuit_state:string; circuit_open_until:string|null }>(`select merchant_id,connector_type,base_url,auth_type,credentials_encrypted,field_mapping,scopes,status,sync_mode,circuit_state,circuit_open_until from brand_integration_connections where id=$1`, [input.connectionId]);
  const c = rows[0];
  await assertLiveBrandAuthorization(sql,input.connectionId);
  if (!c || c.status !== "active") throw new Error("Integration connection is not active");
  if (!c.scopes.includes("catalog:read")) throw new Error("catalog:read scope required");
  if (!c.base_url) throw new Error("Connection has no feed endpoint");
  if (c.circuit_state==='open' && c.circuit_open_until && new Date(c.circuit_open_until).getTime()>Date.now()) throw new Error("Integration circuit breaker is open");
  const leaseOwner=`sync_${randomUUID().replaceAll("-","")}`;
  const lease=await sql.query<{id:string}>(`update brand_integration_connections set sync_lease_owner=$2,sync_lease_until=now()+interval '5 minutes',last_sync_started_at=now(),circuit_state=case when circuit_state='open' then 'half_open' else circuit_state end where id=$1 and status='active' and (sync_lease_until is null or sync_lease_until<now()) returning id`,[input.connectionId,leaseOwner]);
  if(!lease[0]) throw new Error("Integration sync already in progress");
  let response: {status:number;body:string};
  try {
    const url = await assertPublicHttpsEndpoint(c.base_url);
    const credentials = (await loadBrandIntegrationCredentials(sql,input.connectionId)).credentials;
    const headers = new Headers({ accept: c.connector_type === "csv" ? "text/csv,application/csv" : c.connector_type === "xml" ? "application/xml,text/xml" : "application/json" });
    if (c.auth_type === "bearer") { if (!credentials.token) throw new Error("Integration bearer credential is not configured"); headers.set("authorization", `Bearer ${credentials.token}`); }
    if (c.auth_type === "api_key") { if (!credentials.apiKey) throw new Error("Integration API key is not configured"); headers.set("x-api-key", credentials.apiKey); }
    if (c.auth_type === "basic") { if (!credentials.username || !credentials.password) throw new Error("Integration basic credentials are not configured"); headers.set("authorization", `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`); }
    if (c.auth_type === "hmac") {
      if (!credentials.secret) throw new Error("Integration HMAC credential is not configured");
      const ts=String(Date.now());
      headers.set("x-elemarket-timestamp",ts);
      headers.set("x-elemarket-signature",`sha256=${createHmac("sha256",credentials.secret).update(`${ts}.GET.${url.pathname}${url.search}`,"utf8").digest("hex")}`);
    }
    response = await pinnedGet(url, headers);
    if (response.status < 200 || response.status >= 300) throw new Error(`Integration endpoint returned HTTP ${response.status}`);
  } catch (error) {
    await sql.query(`update brand_integration_connections set circuit_state=case when consecutive_failures+1>=5 then 'open' else 'closed' end,circuit_open_until=case when consecutive_failures+1>=5 then now()+interval '5 minutes' else null end,consecutive_failures=consecutive_failures+1,last_health_check_at=now(),last_error=$2,updated_at=now(),sync_lease_owner=null,sync_lease_until=null where id=$1 and sync_lease_owner=$3`,[input.connectionId,(error instanceof Error?error.message:'Integration fetch failed').replace(/(?:https?:\/\/)?[^\s]+/g,'[redacted]').slice(0,500),leaseOwner]);
    throw error;
  }
  const type = c.connector_type === "xml" ? "xml" : "csv";
  let records: BrandFeedRecord[];
  try {
    if (c.connector_type === "rest_json" || c.connector_type === "erp_oms_wms") {
      const parsed = JSON.parse(response.body) as unknown;
      assertSafeJson(parsed);
      const list: unknown[] = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).products)
          ? (parsed as Record<string, unknown>).products as unknown[]
          : []);
      if (list.length > MAX_FEED_RECORDS) throw new Error("Integration response exceeds record limit");
      records = list.map((x: unknown) => {
        if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Invalid integration response record");
        return asRecord(x as Record<string, unknown>, c.field_mapping ?? {});
      });
    } else records = parseBrandFeed(response.body,type,c.field_mapping ?? {});
    const result = await ingestBrandFeed({ connectionId: input.connectionId, source: input.source ?? "scheduled", records, authoritativeSnapshot: c.sync_mode === "snapshot" });
    await sql.query(`update brand_integration_connections set circuit_state='closed',circuit_open_until=null,consecutive_failures=0,last_health_check_at=now(),last_error=null,sync_lease_owner=null,sync_lease_until=null where id=$1 and sync_lease_owner=$2`,[input.connectionId,leaseOwner]);
    return result;
  } catch (error) {
    await sql.query(`update brand_integration_connections set sync_lease_owner=null,sync_lease_until=null,last_error=$2,updated_at=now() where id=$1 and sync_lease_owner=$3`,[input.connectionId,(error instanceof Error?error.message:'Integration processing failed').slice(0,1000),leaseOwner]);
    throw error;
  }
}

export function signBrandWebhook(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function signBrandWebhookV2(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

export function verifyBrandWebhook(secret: string, rawBody: string, signature: string | null, timestamp: string | null = null): boolean {
  if (!signature) return false;
  if (timestamp) {
    const millis = Number(timestamp);
    if (!Number.isSafeInteger(millis) || Math.abs(Date.now() - millis) > 5 * 60 * 1000) return false;
  }
  const digest = timestamp ? signBrandWebhookV2(secret, timestamp, rawBody) : signBrandWebhook(secret, rawBody);
  const expected = Buffer.from(digest, "hex");
  const suppliedText = signature.trim().replace(/^sha256=/, "");
  if (!/^[a-f0-9]{64}$/i.test(suppliedText)) return false;
  const supplied = Buffer.from(suppliedText, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export type BrandIntegrationHealthConnection = {
  id: string;
  brand_id: string;
  name: string;
  connector_type: BrandConnectorType;
  environment: BrandEnvironment;
  status: string;
  last_sync_status: string | null;
  last_sync_completed_at: string | null;
  last_inventory_sync_at: string | null;
  stale_after_seconds: number;
  last_sync_count: number;
  last_error: string | null;
};

export type BrandIntegrationHealthDiscrepancy = {
  connection_id: string;
  open_count: number;
};

export type BrandIntegrationHealth = {
  connections: BrandIntegrationHealthConnection[];
  discrepancies: BrandIntegrationHealthDiscrepancy[];
};

export async function getBrandIntegrationHealth(input: { merchantId: string }): Promise<BrandIntegrationHealth> {
  const sql = await getSql();
  const connections = await sql.query<BrandIntegrationHealthConnection>(`select id,brand_id,name,connector_type,environment,status,last_sync_status,last_sync_completed_at,last_inventory_sync_at,stale_after_seconds,last_sync_count,last_error from brand_integration_connections where merchant_id=$1 order by created_at desc`, [input.merchantId]);
  const discrepancies = await sql.query<BrandIntegrationHealthDiscrepancy>(`select connection_id,count(*) filter(where status='open')::int as open_count from brand_integration_reconciliation where merchant_id=$1 group by connection_id`, [input.merchantId]);
  return { connections, discrepancies };
}

async function pinnedPost(url: URL, headers: Headers, body: string): Promise<{ status: number; response: string }> {
  const { lookup } = await import("node:dns/promises");
  const { request } = await import("node:https");
  const { isPrivateOrReservedIp } = await import("@/lib/security/ssrf.server");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const publicAddresses = addresses.map((a) => a.address).filter((a) => !isPrivateOrReservedIp(a));
  if (!publicAddresses.length) throw new Error("Integration endpoint no longer resolves to a public address");
  const address = publicAddresses[0];
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: "https:", hostname: address, port: 443, path: `${url.pathname}${url.search}`, method: "POST",
      servername: url.hostname, headers: { ...Object.fromEntries(headers.entries()), host: url.hostname },
      lookup: (_host, _opts, cb) => cb(null, address, address.includes(":") ? 6 : 4), timeout: 15_000,
    }, (res) => {
      let total = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk) => { total += Buffer.byteLength(chunk); if (total > 2 * 1024 * 1024) { req.destroy(new Error("Integration response too large")); return; } chunks.push(Buffer.from(chunk)); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, response: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Integration request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function processBrandIntegrationOrderOutbox(limit = 25) {
  const sql = await getSql();
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  await sql.query(`select recover_brand_integration_processing_claims(600)`);
  const claimed = await sql.query<{id:string;connection_id:string;merchant_id:string;order_id:string;event_type:string;payload:unknown;attempts:number;idempotency_key:string;locked_token:string}>(`
    with claimed as (
      select id from brand_integration_order_outbox
       where status in ('pending','retry') and coalesce(available_at,now())<=now()
       order by available_at,created_at,id for update skip locked limit $1
    )
    update brand_integration_order_outbox o set status='processing',locked_at=now(),locked_token=gen_random_uuid()::text,attempts=o.attempts+1,updated_at=now()
      from claimed where o.id=claimed.id
      returning o.id,o.connection_id,o.merchant_id,o.order_id,o.event_type,o.payload,o.attempts,o.idempotency_key,o.locked_token`, [bounded]);
  let sent=0,retried=0,dead=0;
  for (const item of claimed) {
    try {
      await assertLiveBrandAuthorization(sql,item.connection_id);
      const rows = await sql.query<{base_url:string|null;auth_type:string;credentials_encrypted:string|null;scopes:string[];status:string;merchant_id:string}>(`select base_url,auth_type,credentials_encrypted,scopes,status,merchant_id from brand_integration_connections where id=$1`,[item.connection_id]);
      const c=rows[0];
      const orderRows=await sql.query<{merchant_id:string}>(`select merchant_id from orders where id=$1`,[item.order_id]);
      if (!c || c.status !== "active" || c.merchant_id !== item.merchant_id || orderRows[0]?.merchant_id !== item.merchant_id || !c.scopes.includes("orders:write") || !c.base_url) throw new Error("Integration order endpoint is unavailable or unauthorized");
      const url=await assertPublicHttpsEndpoint(c.base_url);
      const credentials=(await loadBrandIntegrationCredentials(sql,item.connection_id)).credentials;
      const headers=new Headers({"content-type":"application/json",accept:"application/json"});
      if(c.auth_type==="bearer") headers.set("authorization",`Bearer ${credentials.token??""}`);
      if(c.auth_type==="api_key") headers.set("x-api-key",credentials.apiKey??"");
      if(c.auth_type==="basic") headers.set("authorization",`Basic ${Buffer.from(`${credentials.username??""}:${credentials.password??""}`).toString("base64")}`);
      const body=JSON.stringify({eventType:item.event_type,eventId:item.id,orderId:item.order_id,payload:item.payload});
      headers.set("idempotency-key",item.idempotency_key);
      if(c.auth_type==="hmac"){ const ts=String(Date.now()); headers.set("x-elemarket-timestamp",ts); headers.set("x-elemarket-signature",`sha256=${createHmac("sha256",credentials.secret??"").update(`${ts}.${body}`,"utf8").digest("hex")}`); }
      const result=await pinnedPost(url,headers,body);
      if(result.status<200||result.status>=300) throw new Error(`Integration order endpoint returned HTTP ${result.status}`);
      await sql.query(`update brand_integration_order_outbox set status='sent',sent_at=now(),updated_at=now(),last_error=null,locked_at=null,locked_token=null where id=$1 and locked_token=$2`,[item.id,item.locked_token]); sent++;
    } catch(error) {
      const message=error instanceof Error?error.message:"Integration order delivery failed";
      const terminal=item.attempts>=10;
      await sql.query(`update brand_integration_order_outbox set status=$2,available_at=case when $2='retry' then now()+least(interval '6 hours',interval '5 seconds'*power(2,least(attempts-1,10)) + interval '1 second'*floor(random()*10)) else null end,last_error=$3,updated_at=now(),locked_token=null,locked_at=null where id=$1 and locked_token=$4`,[item.id,terminal?'dead':'retry',message.replace(/(?:https?:\/\/)?[^\s]+/g,'[redacted]').slice(0,500),item.locked_token]);
      if(terminal) dead++; else retried++;
    }
  }
  return { claimed: claimed.length, sent, retried, dead };
}

export async function enqueueBrandIntegrationWebhook(input:{connectionId:string;externalEventId:string|null;eventType:string;rawBody:string;payload:unknown}) {
  const sql=await getSql();
  if (Buffer.byteLength(input.rawBody,"utf8") > 2*1024*1024) throw new Error("Webhook payload too large");
  assertSafeJson(input.payload);
  const eventType=input.eventType.trim();
  if (!ALLOWED_WEBHOOK_EVENTS.has(eventType)) throw new Error("Unsupported integration webhook event");
  const rows=await sql.query<{id:string;merchant_id:string;webhook_secret_encrypted:string|null;webhook_enabled:boolean;status:string}>(`select id,merchant_id,webhook_secret_encrypted,webhook_enabled,status from brand_integration_connections where id=$1`,[input.connectionId]);
  const c=rows[0];
  if(!c || c.status!=='active' || !c.webhook_enabled || !c.webhook_secret_encrypted) throw new Error("Integration webhook is not active");
  await assertLiveBrandAuthorization(sql,input.connectionId);
  const payloadHash=sha256(input.rawBody);
  const eventIdentity=input.externalEventId?.trim().slice(0,200) || null;
  const normalizedExternalId=eventIdentity;
  const deterministicIdentity=eventIdentity || `${eventType}:${payloadHash}`;
  const id=`bigwe_${randomUUID().replaceAll("-","")}`;
  const result=await sql.query<{id:string}>(`insert into brand_integration_webhook_events(id,connection_id,merchant_id,external_event_id,event_type,payload_hash,event_identity,payload) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb) on conflict(connection_id,event_identity) do nothing returning id`,[id,c.id,c.merchant_id,normalizedExternalId,eventType,payloadHash,deterministicIdentity,JSON.stringify(input.payload)]);
  if(result[0]) return {accepted:true,duplicate:false,eventId:result[0].id};
  const existing=await sql.query<{id:string;payload_hash:string;event_type:string}>(`select id,payload_hash,event_type from brand_integration_webhook_events where connection_id=$1 and event_identity=$2`,[c.id,deterministicIdentity]);
  if (!existing[0] || existing[0].payload_hash !== payloadHash || existing[0].event_type !== eventType) {
    throw new Error("Brand integration webhook event identity reused with conflicting payload");
  }
  return {accepted:true,duplicate:true,eventId:existing[0].id};
}

export async function processBrandIntegrationWebhooks(limit=25) {
  const sql=await getSql();
  const bounded=Math.min(Math.max(Math.trunc(limit),1),100);
  const claimed=await sql.query<{id:string;connection_id:string;merchant_id:string;event_type:string;payload:unknown;attempts:number;locked_token:string}>(`with claimed as (select id from brand_integration_webhook_events where status in ('received','failed') and coalesce(next_attempt_at,received_at)<=now() order by coalesce(next_attempt_at,received_at),received_at,id for update skip locked limit $1) update brand_integration_webhook_events e set status='processing',attempts=e.attempts+1,next_attempt_at=null,locked_at=now(),locked_token=gen_random_uuid()::text where e.id=claimed.id returning e.id,e.connection_id,e.merchant_id,e.event_type,e.payload,e.attempts,e.locked_token`,[bounded]);
  let processed=0,retried=0,dead=0;
  for(const item of claimed){
    try{
      await assertLiveBrandAuthorization(sql,item.connection_id);
      await fetchAndSyncBrandConnection({connectionId:item.connection_id,source:"webhook"});
      await sql.query(`update brand_integration_webhook_events set status='processed',processed_at=now(),last_error=null,locked_at=null,locked_token=null where id=$1 and locked_token=$2`,[item.id,item.locked_token]);
      processed++;
    }catch(error){
      const message=error instanceof Error?error.message:"Integration webhook processing failed";
      const terminal=item.attempts>=10;
      await sql.query(`update brand_integration_webhook_events set status=$2,next_attempt_at=case when $2='failed' then now()+least(interval '6 hours',interval '5 seconds'*power(2,least(attempts-1,10)) + interval '1 second'*floor(random()*10)) else null end,last_error=$3,locked_at=null,locked_token=null where id=$1 and locked_token=$4`,[item.id,terminal?'dead':'failed',message.replace(/(?:https?:\/\/)?[^\s]+/g,'[redacted]').slice(0,500),item.locked_token]);
      if(terminal) dead++; else retried++;
    }
  }
  return {claimed:claimed.length,processed,retried,dead};
}

export async function verifyStoredBrandWebhook(connectionId:string, rawBody:string, signature:string|null, timestamp:string|null=null):Promise<boolean>{
  const sql=await getSql();
  const rows=await sql.query<{enabled:boolean;status:string}>(`select webhook_enabled as enabled,status from brand_integration_connections where id=$1`,[connectionId]);
  const row=rows[0];
  if(!row||!row.enabled||row.status!=='active') return false;
  try { await assertLiveBrandAuthorization(sql,connectionId); } catch { return false; }
  const {webhookSecret}=await loadBrandIntegrationCredentials(sql,connectionId);
  return webhookSecret ? verifyBrandWebhook(webhookSecret,rawBody,signature,timestamp) : false;
}
