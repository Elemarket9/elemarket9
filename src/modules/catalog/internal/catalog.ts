import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CATALOG_GROUPS, CATEGORY_KEYS, type CategoryKey } from "../../shared/public/categories";
import { haversineKm } from "../../shared/public/money";
import type { JsonObject, MerchantCard, ProductCard, ProductMedia, ProductVariant } from "../../shared/public/types";

const filterSchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.enum(CATEGORY_KEYS).optional(),
  subcategory: z.string().trim().max(64).optional(),
  brand: z.string().trim().max(120).optional(),
  condition: z.enum(["new","refurbished","used","open_box"]).optional(),
  minPrice: z.number().finite().min(0).optional(),
  maxPrice: z.number().finite().min(0).optional(),
  listingType: z.enum(["product", "food", "stay"]).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().min(3).max(100).optional(),
  merchantId: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(60).optional(),
  sort: z.enum(["relevance","price_asc","price_desc","newest"]).optional(),
  cursor: z.string().max(2048).optional(),
});

type ProductRow = {
  id: string;
  merchant_id: string;
  merchant_name: string;
  neighborhood: string;
  city: string;
  merchant_address: string;
  name: string;
  category: string;
  subcategory: string | null;
  brand: string | null;
  model: string | null;
  sku: string | null;
  condition: "new" | "refurbished" | "used" | "open_box";
  warranty_months: number | null;
  fulfillment_type: "delivery" | "pickup" | "delivery_and_pickup";
  status: "draft" | "pending_review" | "active" | "suspended" | "archived";
  returnable: boolean;
  return_window_days: number | null;
  attributes: JsonObject;
  financing_eligible: boolean;
  financing_min_amount: string | null;
  financing_max_amount: string | null;
  listing_type: "product" | "food" | "stay";
  price: string;
  stock: number;
  has_variants?: boolean;
  description: string;
  image_path: string | null;
  meal_type: string | null;
  cuisine: string | null;
  prep_minutes: number | null;
  guests: number | null;
  verified: boolean;
  lat: number;
  lon: number;
  avg_rating: string | null;
  review_count: number;
};

async function getCatalogServerDeps() {
  const [{ getDiscoverySql:getSql }, { enforceRateLimit }] = await Promise.all([
    import("@/lib/db"),
    import("@/lib/security/rate-limit.server"),
  ]);
  return { getSql, enforceRateLimit };
}

export type ActiveCatalogGroup = {
  key: CategoryKey;
  name: string;
  blurb: string;
  subcategories: Array<{ key: string; name: string }>;
};

export const loadActiveCatalogTaxonomy = createServerFn({ method: "GET" })
  .handler(async (): Promise<ActiveCatalogGroup[]> => {
    const { getSql, enforceRateLimit } = await getCatalogServerDeps();
    await enforceRateLimit("catalog-active-taxonomy", { windowSeconds: 60, maxRequests: 180 });
    const sql = await getSql();
    const categories = await sql.query<{ category_key:string; name:string }>(
      `select category_key,name from category_taxonomy where active=true order by sort_order,category_key`,
    );
    const subcategories = await sql.query<{ category_key:string; subcategory_key:string; name:string }>(
      `select category_key,subcategory_key,name from category_subcategories where active=true order by category_key,sort_order,subcategory_key`,
    );
    return categories.flatMap((row)=>{
      const app = CATALOG_GROUPS.find((group)=>group.key===row.category_key);
      if (!app) return [];
      return [{
        key:row.category_key as CategoryKey,
        name:row.name || app.name,
        blurb:app.blurb,
        subcategories:subcategories.filter((sub)=>sub.category_key===row.category_key).map((sub)=>({key:sub.subcategory_key,name:sub.name})),
      }];
    });
  });



function toCard(row: ProductRow, origin?: { lat: number; lon: number }): ProductCard {
  const distanceKm =
    origin != null
      ? Math.round(haversineKm(origin.lat, origin.lon, Number(row.lat), Number(row.lon)) * 10) / 10
      : null;
  return {
    id: row.id,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    neighborhood: row.neighborhood,
    city: row.city,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory,
    brand: row.brand,
    model: row.model,
    sku: row.sku,
    condition: row.condition,
    warrantyMonths: row.warranty_months == null ? null : Number(row.warranty_months),
    fulfillmentType: row.fulfillment_type,
    status: row.status,
    returnable: Boolean(row.returnable),
    returnWindowDays: row.return_window_days == null ? null : Number(row.return_window_days),
    attributes: row.attributes ?? {},
    financingEligible: Boolean(row.financing_eligible),
    financingMinAmount: row.financing_min_amount == null ? null : String(row.financing_min_amount),
    financingMaxAmount: row.financing_max_amount == null ? null : String(row.financing_max_amount),
    listingType: row.listing_type,
    price: String(row.price),
    currency: "GHS",
    stock: Number(row.stock),hasVariants:Boolean(row.has_variants),
    description: row.description,
    imagePath: row.image_path,
    mealType: row.meal_type,
    cuisine: row.cuisine,
    prepMinutes: row.prep_minutes == null ? null : Number(row.prep_minutes),
    guests: row.guests == null ? null : Number(row.guests),
    distanceKm,
    verified: Boolean(row.verified),
    merchantAddress: row.merchant_address,
    avgRating: row.avg_rating == null ? null : Number(row.avg_rating),
    reviewCount: Number(row.review_count ?? 0),
  };
}

export type CatalogSearchPage = {
  products: ProductCard[];
  total: number;
  totalExact: boolean;
  facetsSampled: boolean;
  nextCursor: string | null;
  facets: Record<string, Array<{ value: string; count: number }>>;
  interpretedQuery: { identifier?: string; tokens: string[]; effectiveQuery?: string; expandedTerms?: string[][]; attributes?: { key:string; value:string; hard:boolean }[]; degraded?: boolean };
  interpretedFilters: Record<string,string|number|boolean|null>;
  searchVersion: string;
};

export async function hydrateSearchHits(sql: {query<T>(text:string,values?:unknown[]):Promise<T[]>},hits:Array<{id:string;attributionReceipt?:string}>,data:z.infer<typeof filterSchema>){
 const ids=[...new Set(hits.map(h=>h.id))].slice(0,60);if(!ids.length)return [] as ProductCard[];
 const rows=await sql.query<ProductRow>(`with ratings as (select product_id,round(avg(rating)::numeric,2)::text avg_rating,count(*)::int review_count from reviews where product_id=any($1::text[]) group by product_id)
 select p.id,p.merchant_id,m.name merchant_name,m.neighborhood,m.city,m.address merchant_address,p.name,p.category,p.subcategory,p.brand,p.model,p.sku,p.condition,p.warranty_months,p.fulfillment_type,p.status,p.returnable,p.return_window_days,p.attributes,p.financing_eligible,p.financing_min_amount,p.financing_max_amount,p.listing_type,(coalesce((select min(vp.price) from product_variants vp where vp.product_id=p.id and vp.status='active' and vp.stock>0),(select min(vp.price) from product_variants vp where vp.product_id=p.id and vp.status='active'),p.price))::text price,p.stock,exists(select 1 from product_variants pv where pv.product_id=p.id and pv.status='active' and pv.stock>0) has_variants,p.description,p.image_path,p.meal_type,p.cuisine,p.prep_minutes,p.guests,m.verified,m.lat,m.lon,r.avg_rating,coalesce(r.review_count,0) review_count
 from products p join merchants m on m.id=p.merchant_id left join ratings r on r.product_id=p.id
 where p.id=any($1::text[]) and p.status='active' and p.stock>0 and m.status='active' and m.verified=true
 and exists(select 1 from category_taxonomy c where c.category_key=p.category and c.active=true)
 and (p.subcategory is null or exists(select 1 from category_subcategories s where s.category_key=p.category and s.subcategory_key=p.subcategory and s.active=true))
 and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections c on c.id=o.connection_id where o.product_id=p.id and o.status='active' and c.status='active' and o.last_seen_at>=now()-make_interval(secs=>c.stale_after_seconds)))`,[ids]);
 const byId=new Map(rows.map(row=>[row.id,row]));const receipts=new Map(hits.map(h=>[h.id,h.attributionReceipt]));
 return ids.flatMap(id=>{const row=byId.get(id);if(!row)return [];const card=toCard(row,data.lat!=null&&data.lon!=null?{lat:data.lat,lon:data.lon}:undefined);card.attributionReceipt=receipts.get(id);return [card];});
}

async function searchCatalogPage(data:z.infer<typeof filterSchema>):Promise<CatalogSearchPage>{
  const {getSql,enforceRateLimit}=await getCatalogServerDeps(); await enforceRateLimit("catalog-search-products",{windowSeconds:60,maxRequests:120});
  const sql=await getSql(); const {searchProducts}=await import("./search.server");
  const result=await searchProducts({q:data.q?.trim()??"",lat:data.lat,lon:data.lon,radiusKm:data.radiusKm,category:data.category,subcategory:data.subcategory,brand:data.brand,condition:data.condition,minPrice:data.minPrice,maxPrice:data.maxPrice,merchantId:data.merchantId,listingType:data.listingType,inStock:true,sort:data.sort??"relevance",limit:data.limit??40,cursor:data.cursor});
  return {products:await hydrateSearchHits(sql,result.hits,data),total:result.total,totalExact:Boolean(result.totalExact),facetsSampled:Boolean(result.facetsSampled),nextCursor:result.nextCursor,facets:result.facets,interpretedQuery:result.interpretedQuery,interpretedFilters:result.interpretedFilters??{},searchVersion:result.searchVersion};
}


export const searchCatalogProducts=createServerFn({method:'GET'}).validator(filterSchema).handler(({data})=>searchCatalogPage(data));
export const listProducts=createServerFn({method:'GET'}).validator(filterSchema).handler(async({data})=>(await searchCatalogPage({...data,limit:data.limit??48})).products);

export const getProduct = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.string().min(1).max(64) }))
  .handler(async ({ data }) => {
    const { getSql, enforceRateLimit } = await getCatalogServerDeps();
    await enforceRateLimit("catalog-get-product", { windowSeconds: 60, maxRequests: 180 });
    const sql = await getSql();
    const rows = await sql.query<ProductRow>(
      `select p.id, p.merchant_id, m.name as merchant_name, m.neighborhood, m.city, m.address as merchant_address,
              p.name, p.category, p.subcategory, p.brand, p.model, p.sku, p.condition, p.warranty_months, p.fulfillment_type, p.status, p.returnable, p.return_window_days, p.attributes, p.financing_eligible, p.financing_min_amount, p.financing_max_amount, p.listing_type, p.price::text as price, p.stock, p.description, p.image_path,
              p.meal_type, p.cuisine, p.prep_minutes, p.guests, m.verified, m.lat, m.lon,
                (select round(avg(r.rating)::numeric,2)::text from reviews r where r.product_id=p.id) as avg_rating,
                (select count(*)::int from reviews r where r.product_id=p.id) as review_count
         from products p
         join merchants m on m.id = p.merchant_id
         join category_taxonomy ct on ct.category_key=p.category and ct.active=true
         left join category_subcategories cs on cs.category_key=p.category and cs.subcategory_key=p.subcategory
        where p.id = $1 and m.status = 'active' and m.verified = true and p.status = 'active'
          and (p.subcategory is null or cs.active=true) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections c on c.id=o.connection_id where o.product_id=p.id and o.status='active' and c.status='active' and o.last_seen_at>=now()-make_interval(secs=>c.stale_after_seconds)))`,
      [data.id],
    );
    const product = rows[0] ? toCard(rows[0]) : null;
    if (!product) return { product: null, variants: [] as ProductVariant[], media: [] as ProductMedia[], related: [] as ProductCard[], seo: null };
    const seoRows = await sql.query<{ indexability_score: number; index_decision: "index" | "noindex"; reason: JsonObject }>(
      `select s.indexability_score,
              case when s.calculated_at >= p.updated_at and s.calculated_at >= now()-interval '6 hours' then s.index_decision else 'noindex' end as index_decision,
              s.reason
         from eide_seo_pages s join products p on p.id=s.entity_key
        where s.page_key=$1 and s.page_type='product' limit 1`,
      [`product:${product.id}`],
    ).catch(() => []);
    const seo = seoRows[0] ? { indexabilityScore: Number(seoRows[0].indexability_score), indexDecision: seoRows[0].index_decision, reason: seoRows[0].reason } : null;
    const mediaRows = await sql.query<{
      id: string; product_id: string; kind: ProductMedia["kind"]; storage_key: string;
      alt_text: string | null; sort_order: number; is_primary: boolean;
    }>(
      `select id, product_id, media_type as kind, storage_key, alt_text, sort_order, is_primary
         from product_media
        where product_id = $1 and media_type = 'image'
        order by is_primary desc, sort_order asc, id asc
        limit 12`,
      [product.id],
    );
    const media: ProductMedia[] = mediaRows.map((m) => ({
      id: m.id, productId: m.product_id, kind: m.kind, storageKey: `/api/product-media/${encodeURIComponent(m.id)}`,
      altText: m.alt_text, sortOrder: Number(m.sort_order), isPrimary: Boolean(m.is_primary),
    }));

    const variantRows = await sql.query<{
      id: string; product_id: string; sku: string; name: string | null;
      attributes: JsonObject; price: string; stock: number;
      status: ProductVariant["status"];
    }>(
      `select id, product_id, sku, name, attributes, price::text as price, stock, status
         from product_variants
        where product_id = $1 and status = 'active' and stock > 0
        order by id`,
      [product.id],
    );
    const variants: ProductVariant[] = variantRows.map((v) => ({
      id: v.id, productId: v.product_id, sku: v.sku, name: v.name,
      attributes: v.attributes ?? {}, price: String(v.price), stock: Number(v.stock), status: v.status,
    }));
    // Product-detail discovery uses the same authoritative EIDE browse ranking
    // as catalogue search rather than an unrelated alphabetical query.
    const { searchProducts } = await import("./search.server");
    const relatedSearch = await searchProducts({
      q: product.subcategory?"":product.brand??product.name, category: product.category as CategoryKey, subcategory: product.subcategory ?? undefined,
      inStock: true, sort: "relevance", limit: 8,
    }).catch(()=>null);
    const relatedHits = (relatedSearch?.hits??[]).filter((hit) => hit.id !== product.id).slice(0, 4);
    const related = await hydrateSearchHits(sql, relatedHits, {
      category: product.category as CategoryKey, subcategory: product.subcategory ?? undefined, limit: 8,
    }).catch(()=>[]);
    return { product, variants, media, related, seo };
  });

export const listMerchants = createServerFn({ method: "GET" })
  .validator(
    z.object({
      lat: z.number().min(-90).max(90).optional(),
      lon: z.number().min(-180).max(180).optional(),
      radiusKm: z.number().min(3).max(100).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { getSql, enforceRateLimit } = await getCatalogServerDeps();
    await enforceRateLimit("catalog-list-merchants", { windowSeconds: 60, maxRequests: 120 });
    const sql = await getSql();
    const rows = await sql.query<{
      id: string;
      name: string;
      category: string;
      neighborhood: string;
      city: string;
      address: string;
      description: string;
      tier: string;
      verified: boolean;
      lat: number;
      lon: number;
    }>(
      `select id, name, category, neighborhood, city, address, description, tier, verified, lat, lon
         from merchants
        where status = 'active' and verified = true
        order by name limit 500`,
    );
    const origin =
      data.lat != null && data.lon != null ? { lat: data.lat, lon: data.lon } : null;
    const radius = data.radiusKm ?? 100;
    const merchants: MerchantCard[] = rows.map((r) => {
      const distanceKm = origin
        ? Math.round(haversineKm(origin.lat, origin.lon, Number(r.lat), Number(r.lon)) * 10) / 10
        : null;
      return {
        id: r.id,
        name: r.name,
        category: r.category,
        neighborhood: r.neighborhood,
        city: r.city,
        address: r.address,
        description: r.description,
        tier: r.tier,
        verified: Boolean(r.verified),
        // Do not expose exact merchant coordinates in the public catalogue.
        // Distance is sufficient for discovery; precise coordinates belong in
        // authenticated delivery/dispatch flows.
        lat: null,
        lon: null,
        distanceKm,
      };
    });
    return merchants.filter((m) => m.distanceKm == null || m.distanceKm <= radius);
  });

export const getMerchant = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.string().min(1).max(64) }))
  .handler(async ({ data }) => {
    const { getSql, enforceRateLimit } = await getCatalogServerDeps();
    await enforceRateLimit("catalog-get-merchant", { windowSeconds: 60, maxRequests: 180 });
    const sql = await getSql();
    const merchants = await sql.query<{
      id: string;
      name: string;
      category: string;
      neighborhood: string;
      city: string;
      address: string;
      description: string;
      tier: string;
      verified: boolean;
      lat: number;
      lon: number;
    }>(
      `select id, name, category, neighborhood, city, address, description, tier, verified, lat, lon
         from merchants where id = $1 and status = 'active' and verified = true`,
      [data.id],
    );
    const merchant = merchants[0];
    if (!merchant) return { merchant: null, products: [] as ProductCard[],discovery:null };
    const page=await searchCatalogPage({merchantId:merchant.id,limit:40}).catch(()=>null);
    const card: MerchantCard = {
      id: merchant.id,
      name: merchant.name,
      category: merchant.category,
      neighborhood: merchant.neighborhood,
      city: merchant.city,
      address: merchant.address,
      description: merchant.description,
      tier: merchant.tier,
      verified: Boolean(merchant.verified),
      lat: null,
      lon: null,
      distanceKm: null,
    };
    return { merchant: card, products:page?.products??[],discovery:page };
  });

export const resolveProductMerchants = createServerFn({ method: "GET" })
  .validator(z.object({ productIds: z.array(z.string().min(1).max(64)).min(1).max(40) }))
  .handler(async ({ data }) => {
    const { getSql, enforceRateLimit } = await getCatalogServerDeps();
    await enforceRateLimit("catalog-resolve-merchants", { windowSeconds: 60, maxRequests: 120 });
    const sql = await getSql();
    const placeholders = data.productIds.map((_, i) => `$${i + 1}`).join(", ");
    const rows = await sql.query<{ id: string; merchant_id: string }>(
      `select id, merchant_id from products where id in (${placeholders}) and status = 'active'`,
      data.productIds,
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.merchant_id])) as Record<string, string>;
  });
