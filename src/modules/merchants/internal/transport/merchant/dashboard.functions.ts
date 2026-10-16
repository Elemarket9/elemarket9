import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getSql, withTransaction } from "@/lib/db";
import { geocodeAddressServer } from "@/modules/logistics/public/adapters/location.server";
import { requireMerchantWorkspaceForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import type { JsonObject, JsonValue } from "@/lib/db-types";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { getMerchantFinanceProvider } from "@/modules/financing/public/merchant-finance.server";
import { saveEnterpriseCatalogConnection, syncEnterpriseCatalog, type EnterpriseCatalogFieldMapping } from "@/modules/merchants/public/enterprise-catalog.server";
import { getEnterpriseHealth, testEnterpriseConnection } from "@/modules/merchants/public/enterprise-integration.server";
import { createBrandIntegrationConnection, getBrandIntegrationHealth, rotateBrandIntegrationCredentials } from "@/modules/merchants/public/brand-integration.server";
import { CATEGORY_KEYS, isValidSubcategory } from "@/modules/shared/public/categories";
import { requireEnterpriseAdmin } from "@/modules/merchants/public/enterprise-multilocation.server";

const merchantIdSchema = z.string().trim().min(1).max(128);
type FulfillmentType = "delivery" | "pickup" | "delivery_and_pickup";

type EnterpriseSyncRun = { id:string; status:string; source:string; generation:string|number; started_at:string; completed_at:string|null; received_count:number; upserted_count:number; deactivated_count:number; error_count:number; cursor_pages:number; error_code:string|null };
type EnterpriseWebhookEvent = { id:string; event_type:string; status:string; attempts:number; received_at:string; processed_at:string|null; next_attempt_at:string|null; error_code:string|null };
type EnterpriseOrderOutbox = { id:string; order_id:string; event_type:string; status:string; attempts:number; available_at:string|null; sent_at:string|null; error_code:string|null; created_at:string; updated_at:string };

async function authorizeMerchant(merchantId: string, userId: string) {
  await requireMerchantWorkspaceForUserId(userId);
  const { requireMerchantAccessForUserId } = await import("@/modules/identity/public/auth/authorization.server");
  await requireMerchantAccessForUserId(merchantId, userId);
}

export const loadMerchantDashboard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = getAuthenticatedUserId(context);
    const principal = await requireMerchantWorkspaceForUserId(userId);
    const sql = await getSql();
    const merchantIds = principal.merchantIds;

    const merchants = await sql.query<{
      merchant_id: string; name: string; category: string; catalog_categories: string[]; city: string; neighborhood: string; address: string;
      description: string; verified: boolean; tier: string; settlement_model: string; catalog_source: string;
      products: number; orders: number;
    }>(
      `select m.id as merchant_id,m.name,m.category,m.catalog_categories,m.city,m.neighborhood,m.address,m.description,m.verified,m.tier,
              m.settlement_model,m.catalog_source,
              (select count(*) from products p where p.merchant_id=m.id)::int as products,
              (select count(*) from orders o where o.merchant_id=m.id)::int as orders
         from merchants m where m.id = any($1::text[]) order by m.name`,
      [merchantIds],
    );

    const promotionRows = await sql.query<{
      promotion_id: string; merchant_id: string; name: string; status: string; starts_at: string; ends_at: string;
      participation_required: boolean; participation_status: string | null; terms_version: string | null;
    }>(
      `select p.id as promotion_id,m.id as merchant_id,p.name,p.status,p.starts_at,p.ends_at,p.participation_required,
              pp.status as participation_status,pp.terms_version
         from promotions p cross join unnest($1::text[]) as m(id)
         left join promotion_participations pp on pp.promotion_id=p.id and pp.merchant_id=m.id
        where p.merchant_id is null and p.status in ('active','draft') and p.ends_at>now()
        order by p.starts_at asc`,
      [merchantIds],
    );

    const finance = getMerchantFinanceProvider();
    const result = await Promise.all(merchants.map(async (merchant) => {
      const [products, orders, catalogRows, inventoryHistory, applicationRows] = await Promise.all([
        sql.query<{id:string;name:string;category:string;subcategory:string|null;brand:string|null;model:string|null;sku:string|null;status:string;price:string;stock:number;listing_type:string;attributes:JsonObject;returnable:boolean;return_window_days:number|null;warranty_months:number|null;fulfillment_type:FulfillmentType;created_at:string}>(
          `select id,name,category,subcategory,brand,model,sku,status,price::text,stock,listing_type,attributes,returnable,return_window_days,warranty_months,fulfillment_type,created_at
             from products where merchant_id=$1 order by created_at desc limit 50`,[merchant.merchant_id]),
        sql.query<{id:string;status:string;grand_total:string;product_total:string;delivery_total:string;address:string;created_at:string;updated_at:string;delivered_at:string|null;eligible_at:string|null;withdrawal_reason:string;withdrawal_eligible:boolean;dispute_filed_at:string|null}>(
          `select o.id,o.status,o.grand_total::text,o.product_total::text,o.delivery_total::text,o.address,o.created_at,o.updated_at,
                  delivered.delivered_at,
                  case when delivered.delivered_at is null then null else delivered.delivered_at + interval '24 hours' end as eligible_at,
                  case
                    when o.status in ('cancelled','refund_pending','refunded','disputed') then 'order_not_withdrawable'
                    when active_dispute.exists_flag then 'active_customer_dispute'
                    when window_dispute.dispute_at is not null then 'customer_dispute_filed_within_24_hours'
                    when delivered.delivered_at is null then 'order_not_delivered'
                    when now() < delivered.delivered_at + interval '24 hours' then '24_hour_customer_dispute_window'
                    else 'eligible'
                  end as withdrawal_reason,
                  (o.status in ('delivered','completed') and delivered.delivered_at is not null and now() >= delivered.delivered_at + interval '24 hours' and not active_dispute.exists_flag and window_dispute.dispute_at is null) as withdrawal_eligible,
                  window_dispute.dispute_at as dispute_filed_at
             from orders o
             left join lateral (select elemarket_order_delivered_at(o.id) as delivered_at) delivered on true
             left join lateral (select exists(select 1 from customer_order_disputes d where d.order_id=o.id and d.status in ('open','under_review')) as exists_flag) active_dispute on true
             left join lateral (select min(d.created_at) as dispute_at from customer_order_disputes d where d.order_id=o.id and delivered.delivered_at is not null and d.created_at <= delivered.delivered_at + interval '24 hours') window_dispute on true
            where o.merchant_id=$1 order by o.created_at desc limit 100`,[merchant.merchant_id]),
        sql.query<{status:string;endpoint_url:string;auth_type:string;response_path:string;sync_mode:string;last_sync_status:string|null;last_sync_completed_at:string|null;last_sync_count:number;webhook_enabled:boolean;page_size:number;cursor_param:string;cursor_path:string|null;inventory_stale_after_seconds:number;last_inventory_sync_at:string|null;last_connection_test_at:string|null;last_connection_test_status:string|null;last_connection_test_error:string|null;order_endpoint_url:string|null;order_webhook_enabled:boolean}>(
          `select status,endpoint_url,auth_type,response_path,sync_mode,last_sync_status,last_sync_completed_at,last_sync_count,webhook_enabled,page_size,cursor_param,cursor_path,inventory_stale_after_seconds,last_inventory_sync_at,last_connection_test_at,last_connection_test_status,last_connection_test_error,order_endpoint_url,order_webhook_enabled
             from enterprise_catalog_connections where merchant_id=$1`,[merchant.merchant_id]),
        sql.query<{id:string;product_id:string;variant_id:string|null;delta:number;reason:string;actor_user_id:string;created_at:string}>(
          `select id,product_id,variant_id,delta,reason,actor_user_id,created_at from merchant_inventory_adjustments where merchant_id=$1 order by created_at desc limit 40`,[merchant.merchant_id]),
        sql.query<{id:string;status:string;registration_number:string|null;business_name:string;business_type:string|null;tax_registration_status:string|null;vat_registration_status:string|null;settlement_method:string|null;check_status:string|null;created_at:string}>(
          `select ma.id,ma.status,ma.registration_number,ma.business_name,ma.business_type,ma.tax_registration_status,ma.vat_registration_status,ma.settlement_method,
                  mvc.status as check_status,ma.created_at
             from merchant_applications ma
             left join merchant_verification_checks mvc on mvc.application_id=ma.id and mvc.check_type='business'
            where ma.merchant_id=$1
            order by ma.created_at desc limit 1`,[merchant.merchant_id]),
      ]);
      const productMedia = await sql.query<{id:string;product_id:string;alt_text:string|null;is_primary:boolean;sort_order:number}>(
        `select pm.id,pm.product_id,pm.alt_text,pm.is_primary,pm.sort_order from product_media pm
           join products p on p.id=pm.product_id
           where p.merchant_id=$1 and p.id=any($2::text[])
           order by pm.product_id,pm.is_primary desc,pm.sort_order,pm.id`,
        [merchant.merchant_id, products.map(p=>p.id)]);
      const profile = {name:merchant.name,description:merchant.description,category:merchant.category,categories:merchant.catalog_categories?.length?merchant.catalog_categories:[merchant.category],address:merchant.address,city:merchant.city,neighborhood:merchant.neighborhood};
      const variants = await sql.query<{id:string;product_id:string;sku:string;name:string|null;price:string;stock:number;status:string;attributes:JsonObject}>(
        `select pv.id,pv.product_id,pv.sku,pv.name,pv.price::text,pv.stock,pv.status,pv.attributes from product_variants pv join products p on p.id=pv.product_id where p.merchant_id=$1 order by pv.created_at desc limit 100`,[merchant.merchant_id]);
      const financeSnapshot = await finance.getSnapshot(merchant.merchant_id);
      const merchantHealthRows = await sql.query<{ score: number | string | null; band: string | null; model_version: string; methodology_version: string; components: JsonObject; calculated_at: string | null; data_period_start: string | null; data_period_end: string | null; sample_size: number; freshness_status: string; fresh_until: string | null }>(
        `select score,band,model_version,methodology_version,components,calculated_at::text,data_period_start::text,data_period_end::text,sample_size,case when fresh_until is not null and fresh_until <= now() then 'stale' else freshness_status end as freshness_status,fresh_until::text
           from merchant_scores where merchant_id=$1 limit 1`, [merchant.merchant_id],
      );
      const merchantHealth = merchantHealthRows[0] ?? null;
      const [merchantFinancingProviders,merchantFinancingApplications] = await Promise.all([
        sql.query<{id:string;name:string;product_type:string;integration_mode:string;provider_legal_name:string|null;terms_url:string|null;privacy_url:string|null;minimum_application_amount:string|null;maximum_application_amount:string|null}>(
          `select id,name,product_type,integration_mode,provider_legal_name,terms_url,privacy_url,minimum_application_amount::text,maximum_application_amount::text
             from financing_providers where audience='merchant' and status='active' and marketplace_enabled=true and marketplace_partner_status='active' and security_review_status in ('passed','waived') and integration_status='ready' and commercial_status='active' and customer_channel_enabled=true order by name`),
        sql.query<{id:string;provider_id:string;provider_name:string;requested_amount:string;currency:string;status:string;score_snapshot:number|null;redirect_url:string|null;created_at:string}>(
          `select a.id,a.provider_id,p.name as provider_name,a.requested_amount::text,a.currency,a.status,a.score_snapshot,a.redirect_url,a.created_at::text
             from merchant_financing_applications a join financing_providers p on p.id=a.provider_id
            where a.merchant_id=$1 order by a.created_at desc limit 20`,[merchant.merchant_id]),
      ]);
      const [performanceRows,funnelRows,questionRows] = await Promise.all([
        sql.query<{ result: JsonObject }>(`select merchant_performance_snapshot($1) as result`, [merchant.merchant_id]),
        sql.query<{ result: JsonObject }>(`select merchant_product_funnel_snapshot($1) as result`, [merchant.merchant_id]),
        sql.query<{id:string;product_id:string;product_name:string;question:string;created_at:string}>(`select q.id,q.product_id,p.name product_name,q.question,q.created_at from product_questions q join products p on p.id=q.product_id where p.merchant_id=$1 and q.status='published' order by q.created_at asc limit 50`,[merchant.merchant_id]),
      ]);
      const performance = performanceRows[0]?.result ?? null;
      const funnel = funnelRows[0]?.result ?? null;
      const activities = [
        ...orders.map((row) => ({ id:`order:${row.id}`, type:"order" as const, title:`Order ${row.id}`, detail:`GHS ${row.grand_total}`, status:row.status, createdAt:row.created_at })),
        ...products.map((row) => ({ id:`listing:${row.id}`, type:"listing" as const, title:`Listed ${row.name}`, detail:`GHS ${row.price} · ${row.stock} in stock`, status:row.status, createdAt:row.created_at })),
      ].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,20);
      return {
        ...merchant, profile, products, productMedia: productMedia.map(pm=>({...pm,url:`/api/product-media/${encodeURIComponent(pm.id)}`})), recentOrders:orders, variants, inventoryHistory, activities,
        finance:financeSnapshot, merchantHealth, merchantFinancingProviders, merchantFinancingApplications, performance, funnel, productQuestions:questionRows, settlementModel:merchant.settlement_model, catalogSource:merchant.catalog_source,
        enterpriseCatalog:catalogRows[0] ?? null,
        enterpriseHealth: merchant.catalog_source === "enterprise_api" ? await getEnterpriseHealth({merchantId:merchant.merchant_id}) : null,
        enterpriseOps: merchant.catalog_source === "enterprise_api" ? await loadEnterpriseOperations(sql, merchant.merchant_id) : null,
        kyb: applicationRows[0] ?? null,
        promotions: promotionRows.filter((p)=>p.merchant_id===merchant.merchant_id).map((p)=>({promotionId:p.promotion_id,name:p.name,status:p.status,startsAt:p.starts_at,endsAt:p.ends_at,participationRequired:p.participation_required,participationStatus:p.participation_status,termsVersion:p.terms_version})),
      };
    }));
    return {role:"merchant" as const,merchants:result};
  });

async function loadEnterpriseOperations(sql: Awaited<ReturnType<typeof getSql>>, merchantId: string) {
  const [syncRuns, webhookEvents, orderOutbox] = await Promise.all([
    sql.query<EnterpriseSyncRun>(`select id,status,source,generation,started_at,completed_at,received_count,upserted_count,deactivated_count,error_count,cursor_pages,case when error_count > 0 then 'SYNC_FAILED' else null end as error_code from enterprise_catalog_sync_runs where merchant_id=$1 order by started_at desc limit 10`, [merchantId]),
    sql.query<EnterpriseWebhookEvent>(`select id,event_type,status,attempts,received_at,processed_at,next_attempt_at,case when last_error is not null then 'WEBHOOK_PROCESSING_FAILED' else null end as error_code from enterprise_webhook_events where merchant_id=$1 order by received_at desc limit 10`, [merchantId]),
    sql.query<EnterpriseOrderOutbox>(`select id,order_id,event_type,status,attempts,available_at,sent_at,case when last_error is not null then 'ORDER_DELIVERY_FAILED' else null end as error_code,created_at,updated_at from enterprise_order_outbox where merchant_id=$1 order by created_at desc limit 10`, [merchantId]),
  ]);
  return { syncRuns, webhookEvents, orderOutbox };
}

const catalogCategorySchema=z.enum(CATEGORY_KEYS);
function validateCatalogTaxonomy(value:{category:string;subcategory?:string},ctx:z.RefinementCtx){
  if(value.subcategory && !isValidSubcategory(value.category,value.subcategory)){
    ctx.addIssue({code:z.ZodIssueCode.custom,path:["subcategory"],message:"Subcategory does not belong to the selected category"});
  }
}
const createListingSchema=z.object({merchantId:merchantIdSchema,name:z.string().trim().min(3).max(200),category:catalogCategorySchema,subcategory:z.string().trim().max(80).optional(),price:z.coerce.number().finite().positive().max(100000000),stock:z.coerce.number().int().min(0).max(1000000),description:z.string().trim().max(4000).default(""),listingType:z.enum(["product","food","stay"]).default("product")}).superRefine(validateCatalogTaxonomy);

const bulkListingRowSchema=z.object({name:z.string().trim().min(3).max(200),category:catalogCategorySchema,subcategory:z.string().trim().max(80).optional(),brand:z.string().trim().max(120).optional(),model:z.string().trim().max(160).optional(),sku:z.string().trim().max(120).optional(),price:z.coerce.number().finite().positive().max(100000000),stock:z.coerce.number().int().min(0).max(1000000),description:z.string().trim().max(4000).default(""),listingType:z.enum(["product","food","stay"]).default("product")}).superRefine(validateCatalogTaxonomy);
export const bulkCreateMerchantListings=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema,rows:z.array(bulkListingRowSchema).min(1).max(200)})).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await authorizeMerchant(data.merchantId,userId);await requireFreshSession();await enforceRateLimit("merchant-listing-bulk-create",{windowSeconds:300,maxRequests:6,subject:userId});const sql=await getSql();const rows=await sql.query<{result:JsonObject}>(`select merchant_bulk_create_products($1,$2,$3::jsonb) as result`,[data.merchantId,userId,JSON.stringify(data.rows)]);return rows[0]?.result??{created:0};});

export const createMerchantListing=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(createListingSchema).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await authorizeMerchant(data.merchantId,userId);await requireFreshSession();await enforceRateLimit("merchant-listing-create",{windowSeconds:60,maxRequests:20,subject:userId});return withTransaction(async (sql)=>{const id=`prod_${randomUUID().replaceAll("-","")}`;await sql.query(`insert into products(id,merchant_id,name,category,subcategory,listing_type,price,currency,stock,description,status) values($1,$2,$3,$4,$5,$6,$7,'GHS',$8,$9,'pending_review')`,[id,data.merchantId,data.name,data.category,data.subcategory??null,data.listingType,data.price,data.stock,data.description]);await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,["merchant.product.created","product",id,userId,"merchant",null,"success",JSON.stringify({merchantId:data.merchantId,status:"pending_review"})]);return{productId:id,status:"pending_review" as const};});});

const updateProductSchema=z.object({attributes:z.record(z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/), z.unknown()).refine(a=>Object.keys(a).length<=64,"Too many specifications").refine(a=>JSON.stringify(a).length<=4000,"Specifications exceed 4 KB"),merchantId:merchantIdSchema,productId:merchantIdSchema,name:z.string().trim().min(3).max(200),category:catalogCategorySchema,subcategory:z.string().trim().max(80).optional(),brand:z.string().trim().max(120).optional(),model:z.string().trim().max(160).optional(),sku:z.string().trim().max(120).optional(),price:z.coerce.number().finite().positive().max(100000000),description:z.string().trim().max(4000),returnable:z.boolean(),returnWindowDays:z.coerce.number().int().min(0).max(90).nullable(),warrantyMonths:z.coerce.number().int().min(0).max(120).nullable(),fulfillmentType:z.enum(["delivery","pickup","delivery_and_pickup"])}).superRefine(validateCatalogTaxonomy);
export const updateMerchantProduct=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(updateProductSchema).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await authorizeMerchant(data.merchantId,userId);await requireFreshSession();await enforceRateLimit("merchant-listing-update",{windowSeconds:60,maxRequests:30,subject:userId});return withTransaction(async (sql)=>{const rows=await sql.query<{id:string;status:string}>(`select id,status from products where id=$1 and merchant_id=$2 and catalog_source='native' for update`,[data.productId,data.merchantId]);if(!rows[0])throw new Error("Product not found");await sql.query(`update products set name=$3,category=$4,subcategory=$5,brand=$6,model=$7,sku=$8,price=$9,description=$10,returnable=$11,return_window_days=$12,warranty_months=$13,fulfillment_type=$14,attributes=$15::jsonb,status=case when status='archived' then status else 'pending_review' end where id=$1 and merchant_id=$2 and catalog_source='native'`,[data.productId,data.merchantId,data.name,data.category,data.subcategory??null,data.brand??null,data.model??null,data.sku??null,data.price,data.description,data.returnable,data.returnWindowDays,data.warrantyMonths,data.fulfillmentType,JSON.stringify(data.attributes)]);await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,["merchant.product.updated","product",data.productId,userId,"merchant",null,"success",JSON.stringify({merchantId:data.merchantId,previousStatus:rows[0].status,newStatus:rows[0].status==='archived'?'archived':'pending_review'})]);return{status:rows[0].status==='archived'?"archived":"pending_review" as const};});});

export const archiveMerchantProduct=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema,productId:merchantIdSchema})).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await authorizeMerchant(data.merchantId,userId);await requireFreshSession();await enforceRateLimit("merchant-listing-archive",{windowSeconds:60,maxRequests:30,subject:userId});return withTransaction(async (sql)=>{const rows=await sql.query<{id:string}>(`update products set status='archived' where id=$1 and merchant_id=$2 and catalog_source='native' and status<>'archived' returning id`,[data.productId,data.merchantId]);if(!rows[0])throw new Error("Product not found or already archived");await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,["merchant.product.archived","product",data.productId,userId,"merchant",null,"success",JSON.stringify({merchantId:data.merchantId})]);return{status:"archived" as const};});});

export const adjustMerchantInventory=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema,productId:merchantIdSchema,variantId:merchantIdSchema.nullable().optional(),delta:z.coerce.number().int().min(-1000000).max(1000000).refine((v)=>v!==0,"Adjustment cannot be zero"),reason:z.string().trim().min(3).max(240)})).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await authorizeMerchant(data.merchantId,userId);await requireFreshSession();await enforceRateLimit("merchant-inventory-adjust",{windowSeconds:60,maxRequests:60,subject:userId});const sql=await getSql();const rows=await sql.query<{result:JsonObject}>(`select merchant_adjust_inventory($1,$2,$3,$4,$5,$6) as result`,[data.merchantId,data.productId,data.variantId??null,data.delta,data.reason,userId]);return rows[0]?.result??null;});

export const advanceMerchantOrder=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema,orderId:merchantIdSchema,toStatus:z.enum(["confirmed","fulfilling","shipped","delivered","completed"]),note:z.string().trim().max(500).optional()})).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await authorizeMerchant(data.merchantId,userId);await requireFreshSession();await enforceRateLimit("merchant-order-status",{windowSeconds:60,maxRequests:60,subject:userId});const sql=await getSql();const rows=await sql.query<{result:JsonObject}>(`select merchant_advance_order($1,$2,$3,$4,$5) as result`,[data.merchantId,data.orderId,data.toStatus,userId,data.note??null]);return rows[0]?.result??null;});

// Business address changes must update the authoritative pickup coordinate.
// Never keep the former latitude/longitude after a merchant moves locations.
export const updateMerchantProfile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({
    merchantId: merchantIdSchema,
    name: z.string().trim().min(2).max(160),
    categories: z.array(catalogCategorySchema).min(1).max(CATEGORY_KEYS.length)
      .refine(v => new Set(v).size === v.length, "Categories must be unique"),
    description: z.string().trim().max(2000),
    address: z.string().trim().min(4).max(400),
    city: z.string().trim().min(1).max(160),
    neighborhood: z.string().trim().min(1).max(160),
  }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await authorizeMerchant(data.merchantId, userId);
    await requireFreshSession();
    await enforceRateLimit("merchant-profile-update", {windowSeconds:60,maxRequests:10,subject:userId});
    const sql = await getSql();
    const existingRows = await sql.query<{ address: string; city: string; neighborhood: string }>(
      `select m.address,m.city,m.neighborhood from merchants m
        where m.id=$1 and exists(
          select 1 from merchant_accounts ma where ma.merchant_id=m.id
          and ma.user_id=$2 and ma.status='active') limit 1`,
      [data.merchantId,userId],
    );
    const existing=existingRows[0];
    if (!existing) throw new Error("Merchant profile not found");
    const locationChanged=existing.address!==data.address || existing.city!==data.city || existing.neighborhood!==data.neighborhood;
    let coordinates: {latitude:number; longitude:number}|null=null;
    if (locationChanged) {
      // Resolve before acquiring a database transaction; geocoding can be slow.
      // If the adapter fails, fail closed rather than publishing a misleading pickup point.
      const location=await geocodeAddressServer(`${data.address}, ${data.neighborhood}, ${data.city}, Ghana`);
      if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)
        || location.latitude<4.5 || location.latitude>11.3 || location.longitude< -3.3 || location.longitude>1.3
        || (location.countryCode && location.countryCode.toLowerCase()!=="gh")) {
        throw new Error("Unable to verify the new business location in Ghana");
      }
      coordinates={latitude:location.latitude,longitude:location.longitude};
    }
    await withTransaction(async transaction=>{
      const rows=await transaction.query<{id:string}>(
        `update merchants set name=$3,category=$4,catalog_categories=$5,description=$6,
          address=$7,city=$8,neighborhood=$9,
          lat=case when $13::boolean then $14::double precision else lat end,
          lon=case when $13::boolean then $15::double precision else lon end
        where id=$1 and address=$10 and city=$11 and neighborhood=$12
          and exists(select 1 from merchant_accounts ma where ma.merchant_id=$1
            and ma.user_id=$2 and ma.status='active') returning id`,
        [data.merchantId,userId,data.name,data.categories[0],data.categories,data.description,
          data.address,data.city,data.neighborhood,existing.address,existing.city,existing.neighborhood,
          locationChanged,coordinates?.latitude??null,coordinates?.longitude??null],
      );
      if(!rows[0]) throw new Error("Merchant location changed concurrently; refresh your profile and retry");
      await transaction.query(
        `select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        ["merchant.profile.updated","merchant",data.merchantId,userId,"merchant",null,"success",
          JSON.stringify({merchantId:data.merchantId,catalogCategories:data.categories,
            locationChanged,coordinates:coordinates ? {latitude:coordinates.latitude,longitude:coordinates.longitude}:null})],
      );
    });
    return {updated:true};
  });

const enterpriseCatalogConnectionSchema=z.object({merchantId:merchantIdSchema,endpointUrl:z.string().url().max(2000),authType:z.enum(["none","bearer","api_key","basic"]),credentials:z.object({token:z.string().max(4000).optional(),apiKey:z.string().max(4000).optional(),username:z.string().max(400).optional(),password:z.string().max(4000).optional()}).optional(),responsePath:z.string().trim().min(1).max(200).default("products"),fieldMapping:z.record(z.string(),z.string().min(1).max(200)).refine((v)=>Boolean(v.id&&v.name&&v.category&&v.price&&v.stock),"id, name, category, price and stock mappings are required"),syncMode:z.enum(["upsert_only","snapshot"]).default("upsert_only"),webhookEnabled:z.boolean().default(false),webhookSecret:z.string().min(32).max(400).optional(),pageSize:z.coerce.number().int().min(1).max(1000).default(250),cursorParam:z.string().trim().min(1).max(80).default("cursor"),cursorPath:z.string().trim().max(200).optional(),inventoryStaleAfterSeconds:z.coerce.number().int().min(60).max(604800).default(900),orderEndpointUrl:z.string().url().max(2000).optional(),orderWebhookSecret:z.string().min(32).max(400).optional()});
export const configureEnterpriseCatalog=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(enterpriseCatalogConnectionSchema).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await requireEnterpriseAdmin(data.merchantId,userId);await requireFreshSession();return saveEnterpriseCatalogConnection({...data,fieldMapping:data.fieldMapping as EnterpriseCatalogFieldMapping});});
export const syncMerchantEnterpriseCatalog=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema})).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await requireEnterpriseAdmin(data.merchantId,userId);await requireFreshSession();return syncEnterpriseCatalog({merchantId:data.merchantId,source:"manual"});});
export const testMerchantEnterpriseConnection=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema})).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await requireEnterpriseAdmin(data.merchantId,userId);await requireFreshSession();return testEnterpriseConnection({merchantId:data.merchantId});});
export const loadMerchantEnterpriseHealth=createServerFn({method:"GET"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema})).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await requireEnterpriseAdmin(data.merchantId,userId);return getEnterpriseHealth({merchantId:data.merchantId});});


const merchantPromotionParticipationSchema=z.object({merchantId:merchantIdSchema,promotionId:merchantIdSchema});
export const setMerchantPromotionParticipation=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(merchantPromotionParticipationSchema.extend({accept:z.boolean()})).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await authorizeMerchant(data.merchantId,userId);const sql=await getSql();const rows=await sql.query<{result:JsonValue}>(`select set_merchant_promotion_participation($1,$2,$3,$4) as result`,[data.promotionId,data.merchantId,data.accept,userId]);return rows[0]?.result??null;});
export const withdrawMerchantPromotionParticipation=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(merchantPromotionParticipationSchema).handler(async({data,context})=>{const userId=getAuthenticatedUserId(context);await authorizeMerchant(data.merchantId,userId);const sql=await getSql();const rows=await sql.query<{result:JsonValue}>(`select withdraw_merchant_promotion_participation($1,$2,$3) as result`,[data.promotionId,data.merchantId,userId]);return rows[0]?.result??null;});


const brandIntegrationConnectionSchema=z.object({
  merchantId:merchantIdSchema,
  organizationId:merchantIdSchema.optional(),
  brandId:merchantIdSchema,
  authorizationId:merchantIdSchema.optional(),
  name:z.string().trim().min(2).max(160),
  connectorType:z.enum(["rest_json","csv","xml","erp_oms_wms","manual_feed"]),
  environment:z.enum(["sandbox","production"]).default("sandbox"),
  baseUrl:z.string().url().max(2000).optional(),
  authType:z.enum(["none","bearer","api_key","basic","hmac"]).default("none"),
  credentials:z.object({token:z.string().max(4000).optional(),apiKey:z.string().max(4000).optional(),username:z.string().max(400).optional(),password:z.string().max(4000).optional()}).optional(),
  scopes:z.array(z.enum(["catalog:read","inventory:read","price:read","orders:write","fulfillment:read","returns:read","warranty:read"])).min(1).max(7),
  capabilities:z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  fieldMapping:z.record(z.string(),z.string().min(1).max(200)).default({}),
  webhookSecret:z.string().min(32).max(400).optional(),
  staleAfterSeconds:z.coerce.number().int().min(60).max(604800).default(900),
});

export const configureBrandDistributorIntegration=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(brandIntegrationConnectionSchema).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context);
  await requireEnterpriseAdmin(data.merchantId,userId);
  await requireFreshSession();
  return createBrandIntegrationConnection(data);
});

export const rotateBrandDistributorIntegrationCredentials=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema,connectionId:merchantIdSchema,credentials:z.object({token:z.string().max(4000).optional(),apiKey:z.string().max(4000).optional(),username:z.string().max(400).optional(),password:z.string().max(4000).optional()}).optional(),webhookSecret:z.string().min(32).max(400).optional()})).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context);
  await requireEnterpriseAdmin(data.merchantId,userId);
  await requireFreshSession();
  const sql=await getSql();
  const owned=await sql.query<{id:string}>(`select id from brand_integration_connections where id=$1 and merchant_id=$2`,[data.connectionId,data.merchantId]);
  if(!owned[0]) throw new Error("Integration connection not found");
  return rotateBrandIntegrationCredentials(data);
});

export const loadBrandDistributorIntegrationHealth=createServerFn({method:"GET"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema})).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context);
  await requireEnterpriseAdmin(data.merchantId,userId);
  return getBrandIntegrationHealth({merchantId:data.merchantId});
});

export const syncBrandDistributorIntegration=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema,connectionId:merchantIdSchema})).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context); await requireEnterpriseAdmin(data.merchantId,userId); await requireFreshSession();
  const sql=await getSql(); const owned=await sql.query<{id:string}>(`select id from brand_integration_connections where id=$1 and merchant_id=$2`,[data.connectionId,data.merchantId]);
  if(!owned[0]) throw new Error("Integration connection not found");
  const {fetchAndSyncBrandConnection}=await import("@/modules/merchants/public/brand-integration.server");
  return fetchAndSyncBrandConnection({connectionId:data.connectionId,source:"scheduled"});
});

export const ingestBrandDistributorFeed=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema,connectionId:merchantIdSchema,format:z.enum(["csv","xml"]),body:z.string().min(1).max(10*1024*1024)})).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context); await requireEnterpriseAdmin(data.merchantId,userId); await requireFreshSession();
  const sql=await getSql(); const rows=await sql.query<{field_mapping:Record<string,string>}>(`select field_mapping from brand_integration_connections where id=$1 and merchant_id=$2`,[data.connectionId,data.merchantId]);
  if(!rows[0]) throw new Error("Integration connection not found");
  const {parseBrandFeed,ingestBrandFeed}=await import("@/modules/merchants/public/brand-integration.server");
  const records=parseBrandFeed(data.body,data.format,rows[0].field_mapping??{});
  return ingestBrandFeed({connectionId:data.connectionId,source:"manual",records});
});

export const listMerchantAdCampaigns=createServerFn({method:"GET"}).middleware([authMiddleware]).validator(z.object({merchantId:merchantIdSchema})).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context); await authorizeMerchant(data.merchantId,userId); const sql=await getSql();
  return sql.query<{id:string;product_id:string;product_name:string;name:string;title:string;subtitle:string|null;placement:string;status:string;starts_at:string;ends_at:string;target_city:string|null;priority:number;impression_count:number;click_count:number;rejection_reason:string|null}>(`select c.id,c.product_id,p.name product_name,c.name,c.title,c.subtitle,c.placement,c.status,c.starts_at,c.ends_at,c.target_city,c.priority,c.impression_count,c.click_count,c.rejection_reason from homepage_ad_campaigns c join products p on p.id=c.product_id and p.merchant_id=c.merchant_id where c.merchant_id=$1 order by c.created_at desc limit 100`,[data.merchantId]);
});
