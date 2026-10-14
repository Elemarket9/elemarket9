import { createHash, createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { getSql } from "@/lib/db";
import { decryptMerchantSensitiveData } from "@/lib/security/merchant-sensitive.server";
import { pinnedGet, syncEnterpriseCatalog } from "@/modules/merchants/internal/enterprise-catalog.server";
import { assertPublicHttpsEndpoint, isPrivateOrReservedIp } from "@/lib/security/ssrf.server";
import type { JsonObject } from "@/lib/db-types";

export async function testEnterpriseConnection(input: { merchantId: string }) {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string; endpoint_url: string; auth_type: "none"|"bearer"|"api_key"|"basic";
    credentials_encrypted: string|null; response_path: string;
  }>(`select id,endpoint_url,auth_type,credentials_encrypted,response_path from enterprise_catalog_connections where merchant_id=$1`, [input.merchantId]);
  const connection = rows[0];
  if (!connection) throw new Error("Enterprise connection is not configured");
  const url = await assertPublicHttpsEndpoint(connection.endpoint_url);
  const credentials = connection.credentials_encrypted
    ? decryptMerchantSensitiveData<Record<string,string>>(connection.credentials_encrypted)
    : {};
  const headers = new Headers({ accept: "application/json" });
  if (connection.auth_type === "bearer") headers.set("authorization", `Bearer ${credentials.token ?? ""}`);
  if (connection.auth_type === "api_key") headers.set("x-api-key", credentials.apiKey ?? "");
  if (connection.auth_type === "basic") headers.set("authorization", `Basic ${Buffer.from(`${credentials.username ?? ""}:${credentials.password ?? ""}`).toString("base64")}`);
  try {
    const response = await pinnedGet(url, headers);
    if (response.status < 200 || response.status >= 300) throw new Error(`Enterprise endpoint returned HTTP ${response.status}`);
    if (Buffer.byteLength(response.body, "utf8") > 2 * 1024 * 1024) throw new Error("Enterprise test response is too large");
    const payload: unknown = JSON.parse(response.body);
    const value = connection.response_path.split(".").reduce<unknown>((current, part) => {
      if (current == null || typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[part];
    }, payload);
    if (!Array.isArray(value)) throw new Error("Configured response path is not an array");
    await sql.query(`update enterprise_catalog_connections set last_connection_test_at=now(),last_connection_test_status='success',last_connection_test_error=null,updated_at=now() where id=$1`, [connection.id]);
    return { ok: true, sampleCount: Math.min(value.length, 20) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Enterprise connection test failed";
    await sql.query(`update enterprise_catalog_connections set last_connection_test_at=now(),last_connection_test_status='failed',last_connection_test_error=$2,updated_at=now() where id=$1`, [connection.id, message.slice(0, 1000)]);
    throw error;
  }
}

export async function getEnterpriseHealth(input: { merchantId: string }) {
  const sql = await getSql();
  const rows = await sql.query<{
    connection_id: string|null; status: string|null; last_sync_status: string|null; last_sync_completed_at: string|null;
    last_sync_count: number; last_inventory_sync_at: string|null; inventory_stale_after_seconds: number;
    last_connection_test_at: string|null; last_connection_test_status: string|null; last_connection_test_error: string|null;
    webhook_enabled: boolean; order_endpoint_url: string|null; consecutive_sync_failures:number; next_sync_at:string|null;
  }>(`select id as connection_id,status,last_sync_status,last_sync_completed_at,last_sync_count,last_inventory_sync_at,inventory_stale_after_seconds,last_connection_test_at,last_connection_test_status,last_connection_test_error,webhook_enabled,order_endpoint_url,coalesce(consecutive_sync_failures,0)::int as consecutive_sync_failures,next_sync_at from enterprise_catalog_connections where merchant_id=$1`, [input.merchantId]);
  const connection = rows[0];
  const [products, outbox, webhooks] = await Promise.all([
    sql.query<{ total: number; out_of_stock: number }>(`select count(*)::int total,count(*) filter(where stock=0)::int out_of_stock from products where merchant_id=$1 and catalog_source='enterprise_api'`, [input.merchantId]),
    sql.query<{ pending: number; failed: number }>(`select count(*) filter(where status in ('pending','retry','processing'))::int pending,count(*) filter(where status='dead')::int failed from enterprise_order_outbox where merchant_id=$1`, [input.merchantId]),
    sql.query<{ pending: number; failed: number }>(`select count(*) filter(where status in ('received','processing'))::int pending,count(*) filter(where status='failed')::int failed from enterprise_webhook_events where merchant_id=$1 and received_at > now()-interval '24 hours'`, [input.merchantId]),
  ]);
  return {
    connection: connection ?? null,
    products: products[0] ?? { total: 0, out_of_stock: 0 },
    orders: outbox[0] ?? { pending: 0, failed: 0 },
    webhooks: webhooks[0] ?? { pending: 0, failed: 0 },
  };
}

export type EnterpriseHealth = Awaited<ReturnType<typeof getEnterpriseHealth>>;

export async function enqueueEnterpriseWebhookEvent(input: { merchantId: string; rawBody: string; eventId: string|null; eventType: string; payload: unknown }) {
  const sql = await getSql();
  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");
  const eventIdentity = input.eventId?.trim().slice(0, 200) || `${input.eventType}:${payloadHash}`;
  const id = `ewe_${randomUUID().replaceAll("-","")}`;
  const rows = await sql.query<{ id: string }>(`
    insert into enterprise_webhook_events(
      id,merchant_id,external_event_id,event_type,payload_hash,event_identity,payload,status,attempts,next_attempt_at,last_attempt_at
    ) values($1,$2,$3,$4,$5,$6,$7::jsonb,'received',0,now(),null)
    on conflict(merchant_id,event_identity) do nothing
    returning id`,
    [id,input.merchantId,input.eventId?.trim().slice(0,200) || null,input.eventType,payloadHash,eventIdentity,JSON.stringify(input.payload)],
  );
  if (rows[0]) return { accepted: true, duplicate: false, eventId: rows[0].id };
  const existing = await sql.query<{ id:string; status:string; payload_hash:string; event_type:string }>(
    `select id,status,payload_hash,event_type from enterprise_webhook_events where merchant_id=$1 and event_identity=$2`,
    [input.merchantId,eventIdentity],
  );
  if (!existing[0] || existing[0].payload_hash !== payloadHash || existing[0].event_type !== input.eventType) {
    throw new Error("Enterprise webhook event identity reused with conflicting payload");
  }
  return { accepted: true, duplicate: true, eventId: existing[0].id, status: existing[0].status };
}

export async function claimEnterpriseWebhookEvents(limit = 25) {
  const sql = await getSql();
  const bounded = Math.min(Math.max(Math.trunc(limit),1),100);
  await sql.query(`select recover_enterprise_webhook_claims(120)`);
  return sql.query<{id:string;merchant_id:string;event_type:string;payload:JsonObject;attempts:number;locked_token:string}>(`
    with claimed as (
      select id
        from enterprise_webhook_events
       where status in ('received','failed')
         and coalesce(next_attempt_at,received_at)<=now()
       order by coalesce(next_attempt_at,received_at),received_at,id
       for update skip locked
       limit $1
    )
    update enterprise_webhook_events e
       set status='processing',locked_at=now(),locked_token=$2,last_attempt_at=now(),attempts=e.attempts+1
      from claimed
     where e.id=claimed.id
     returning e.id,e.merchant_id,e.event_type,e.payload,e.attempts,e.locked_token`,
    [bounded,randomUUID().replaceAll("-","")],
  );
}

export async function processEnterpriseWebhookEvents(limit = 25) {
  const sql = await getSql();
  const claimed = await claimEnterpriseWebhookEvents(limit);
  let processed=0, retried=0, dead=0;
  for (const item of claimed) {
    try {
      // The durable worker is deliberately conservative: the webhook is an invalidation
      // signal, while the catalogue API remains authoritative. A full reconciliation is
      // therefore safer than trusting an untrusted webhook payload as product truth.
      await syncEnterpriseCatalog({ merchantId:item.merchant_id, source:"webhook" });
      await sql.query(`update enterprise_webhook_events set status='processed',processed_at=now(),completed_at=now(),next_attempt_at=null,locked_at=null,locked_token=null,last_error=null where id=$1 and locked_token=$2`,[item.id,item.locked_token]);
      processed++;
    } catch (error) {
      const message=error instanceof Error?error.message:"Enterprise webhook processing failed";
      const terminal=item.attempts>=10;
      await sql.query(`update enterprise_webhook_events set status=$2,next_attempt_at=case when $2='failed' then now()+least(interval '6 hours',interval '5 seconds' * power(2,least(attempts-1,10))) else null end,locked_at=null,locked_token=null,last_error=$3 where id=$1 and locked_token=$4`,[item.id,terminal?'dead':'failed',message.slice(0,1000),item.locked_token]);
      if(terminal) dead++; else retried++;
    }
  }
  return {claimed: claimed.length,processed,retried,dead};
}

export async function claimEnterpriseOrderOutbox(limit = 50) {
  const sql = await getSql();
  const bounded = Math.min(Math.max(Math.trunc(limit),1),100);
  await sql.query(`select recover_enterprise_order_outbox_claims(120)`);
  const token=randomUUID().replaceAll("-","");
  return sql.query<{id:string;merchant_id:string;order_id:string;event_type:string;payload:JsonObject;attempts:number;locked_token:string;delivery_attempt_id:string}>(`
    with claimed as (
      select id
        from enterprise_order_outbox
       where status in ('pending','retry')
         and coalesce(next_attempt_at,available_at)<=now()
       order by coalesce(next_attempt_at,available_at),created_at,id
       for update skip locked
       limit $1
    )
    update enterprise_order_outbox o
       set status='processing',locked_at=now(),locked_token=$2,attempts=o.attempts+1,delivery_attempt_id='ed_'+replace(gen_random_uuid()::text,'-',''),updated_at=now()
      from claimed
     where o.id=claimed.id
     returning o.id,o.merchant_id,o.order_id,o.event_type,o.payload,o.attempts,o.locked_token,o.delivery_attempt_id`,
    [bounded,token],
  );
}

async function pinnedPost(url: URL, headers: Headers, body: string): Promise<{ status: number; response: string }> {
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const publicAddresses = addresses.map(a => a.address).filter(a => !isPrivateOrReservedIp(a));
  if (!publicAddresses.length) throw new Error("Enterprise order endpoint does not resolve to a public address");
  const address = publicAddresses[0];
  return await new Promise((resolve, reject) => {
    const req = httpsRequest({
      protocol: "https:", hostname: address, port: 443, path: `${url.pathname}${url.search}`, method: "POST",
      servername: url.hostname, headers: { ...Object.fromEntries(headers.entries()), host: url.hostname, "content-length": Buffer.byteLength(body) },
      lookup: (_host, _opts, cb) => cb(null, address, address.includes(":") ? 6 : 4), timeout: 15_000,
    }, res => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", chunk => { total += Buffer.byteLength(chunk); if (total > 2 * 1024 * 1024) { req.destroy(new Error("Enterprise order response too large")); return; } chunks.push(Buffer.from(chunk)); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, response: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Enterprise order endpoint timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

export async function deliverEnterpriseOrderOutbox(limit = 25) {
  const sql = await getSql();
  const claimed = await claimEnterpriseOrderOutbox(limit);
  let sent = 0;
  let retried = 0;
  let dead = 0;
  for (const item of claimed) {
    try {
      await sql.query(`insert into enterprise_order_delivery_attempts(id,outbox_id,attempt_no,status) values($1,$2,$3,'started') on conflict(outbox_id,attempt_no) do nothing`,[item.delivery_attempt_id,item.id,item.attempts]);
      const connections = await sql.query<{order_endpoint_url:string|null;auth_type:"none"|"bearer"|"api_key"|"basic";credentials_encrypted:string|null;order_webhook_secret_encrypted:string|null}>(`select order_endpoint_url,auth_type,credentials_encrypted,order_webhook_secret_encrypted from enterprise_catalog_connections where merchant_id=$1 and status='active'`, [item.merchant_id]);
      const connection = connections[0];
      if (!connection?.order_endpoint_url) throw new Error("Enterprise order endpoint is not configured");
      const url = await assertPublicHttpsEndpoint(connection.order_endpoint_url);
      const credentials = connection.credentials_encrypted ? decryptMerchantSensitiveData<Record<string,string>>(connection.credentials_encrypted) : {};
      const orderWebhookSecret = connection.order_webhook_secret_encrypted ? decryptMerchantSensitiveData<{secret:string}>(connection.order_webhook_secret_encrypted).secret : null;
      const headers = new Headers({ accept:"application/json", "content-type":"application/json", "x-elemarket-event-type":item.event_type, "x-elemarket-idempotency-key":`${item.merchant_id}:${item.id}` });
      if (connection.auth_type === "bearer") headers.set("authorization",`Bearer ${credentials.token ?? ""}`);
      if (connection.auth_type === "api_key") headers.set("x-api-key",credentials.apiKey ?? "");
      if (connection.auth_type === "basic") headers.set("authorization",`Basic ${Buffer.from(`${credentials.username ?? ""}:${credentials.password ?? ""}`).toString("base64")}`);
      const body = JSON.stringify({ schemaVersion:1, eventId:item.id, eventType:item.event_type, orderId:item.order_id, occurredAt:new Date().toISOString(), payload:item.payload });
      if(orderWebhookSecret) headers.set("x-elemarket-signature",createHmac("sha256",orderWebhookSecret).update(body).digest("hex"));
      const response = await pinnedPost(url,headers,body);
      if (response.status < 200 || response.status >= 300) throw new Error(`Enterprise order endpoint returned HTTP ${response.status}`);
      const responseHash=createHash('sha256').update(response.response).digest('hex');
      await sql.query(`update enterprise_order_delivery_attempts set status='sent',completed_at=now(),response_status=$2,response_hash=$3 where id=$1`,[item.delivery_attempt_id,response.status,responseHash]);
      await sql.query(`update enterprise_order_outbox set status='sent',sent_at=now(),locked_at=null,locked_token=null,last_error=null,response_status=$2,response_hash=$3,next_attempt_at=null,updated_at=now() where id=$1 and locked_token=$4`, [item.id,response.status,responseHash,item.locked_token]);
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Enterprise order delivery failed";
      const terminal = item.attempts >= 12;
      await sql.query(`update enterprise_order_delivery_attempts set status='failed',completed_at=now(),error_code='DELIVERY_FAILED',error_message=$2 where id=$1`,[item.delivery_attempt_id,message.slice(0,1000)]);
      await sql.query(`update enterprise_order_outbox set status=$2,available_at=case when $2='retry' then now()+least(interval '6 hours',interval '5 seconds' * power(2,least(attempts-1,10))) else available_at end,next_attempt_at=case when $2='retry' then now()+least(interval '6 hours',interval '5 seconds' * power(2,least(attempts-1,10))) else null end,locked_at=null,locked_token=null,last_error=$3,updated_at=now() where id=$1 and locked_token=$4`, [item.id, terminal ? "dead" : "retry", message.slice(0,1000),item.locked_token]);
      if (terminal) dead += 1; else retried += 1;
    }
  }
  return { claimed: claimed.length, sent, retried, dead };
}
