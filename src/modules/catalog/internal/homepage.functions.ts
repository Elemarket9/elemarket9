import { createServerFn } from "@tanstack/react-start";
import { getCookie, setResponseHeader } from "@tanstack/react-start/server";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getSql,getDiscoverySql } from "@/lib/db";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { requireMerchantAccessForUserId, requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { assertSameSiteRequest } from "@/modules/identity/public/auth/isolation.server";
import type { ProductCard } from "@/modules/shared/public/types";
import { env, isWorkspacePreview } from "@/lib/env.server";

export type HomepageSection = {
  key: string; title: string; eyebrow: string | null; priority: number; maxItems: number;
  mobileVisible: boolean; desktopVisible: boolean;
  items: Array<ProductCard & { sponsored?: boolean; adId?: string; adTitle?: string; adSubtitle?: string; destinationType?: string; destinationId?: string; originalPrice?: string; saleEndsAt?: string }>;
};

const productSelect = `select p.id,p.merchant_id,m.name as merchant_name,m.neighborhood,m.city,p.name,p.category,p.subcategory,p.brand,p.model,p.sku,p.condition,p.warranty_months,p.fulfillment_type,p.status,p.returnable,p.return_window_days,p.attributes,p.financing_eligible,p.financing_min_amount,p.financing_max_amount,p.listing_type,(coalesce((select min(vp.price) from product_variants vp where vp.product_id=p.id and vp.status='active' and vp.stock>0),(select min(vp.price) from product_variants vp where vp.product_id=p.id and vp.status='active'),p.price))::text as price,p.stock,exists(select 1 from product_variants pv where pv.product_id=p.id and pv.status='active' and pv.stock>0) has_variants,p.description,p.image_path,(select round(avg(r.rating)::numeric,2)::text from reviews r where r.product_id=p.id) as avg_rating,(select count(*)::int from reviews r where r.product_id=p.id) as review_count,p.meal_type,p.cuisine,p.prep_minutes,p.guests,m.verified,m.lat,m.lon,m.address as merchant_address from products p join merchants m on m.id=p.merchant_id and m.status='active' and m.verified=true join category_taxonomy ct on ct.category_key=p.category and ct.active=true left join category_subcategories cs on cs.category_key=p.category and cs.subcategory_key=p.subcategory`;

function rowToProduct(r: any): ProductCard {
  return {
    id:r.id, merchantId:r.merchant_id, merchantName:r.merchant_name, neighborhood:r.neighborhood, city:r.city,
    name:r.name, category:r.category, subcategory:r.subcategory, brand:r.brand, model:r.model, sku:r.sku,
    condition:r.condition, warrantyMonths:r.warranty_months, fulfillmentType:r.fulfillment_type, status:r.status,
    returnable:Boolean(r.returnable), returnWindowDays:r.return_window_days, attributes:r.attributes ?? {},
    financingEligible:Boolean(r.financing_eligible), financingMinAmount:r.financing_min_amount, financingMaxAmount:r.financing_max_amount,
    listingType:r.listing_type, price:r.price, currency:"GHS", stock:Number(r.stock),hasVariants:Boolean(r.has_variants), description:r.description, imagePath:r.image_path,
    avgRating:r.avg_rating == null ? null : Number(r.avg_rating), reviewCount:Number(r.review_count ?? 0),
    mealType:r.meal_type, cuisine:r.cuisine, prepMinutes:r.prep_minutes, guests:r.guests, distanceKm:null, verified:Boolean(r.verified), merchantAddress:r.merchant_address,
  };
}

const AD_VISITOR_COOKIE = "elemarket.ad_visitor";
const AD_VISITOR_MAX_AGE = 60 * 60 * 24 * 30;
const localAdVisitorSecret = randomBytes(32).toString("hex");
function adVisitorSecret(): string {
  const configured = env("BETTER_AUTH_SECRET");
  if (configured) return configured;
  if (isWorkspacePreview()) return localAdVisitorSecret;
  throw new Error("BETTER_AUTH_SECRET is required for homepage analytics signing");
}
function signAdVisitor(value:string):string {
  return createHmac("sha256", adVisitorSecret()).update(value, "utf8").digest("base64url");
}
function verifyAdVisitor(value:string):string|null {
  const [nonce,signature] = value.split(".");
  if(!nonce || !signature || nonce.length < 32 || nonce.length > 128 || signature.length !== 43) return null;
  const expected=signAdVisitor(nonce);
  const a=Buffer.from(signature); const b=Buffer.from(expected);
  if(a.length!==b.length || !timingSafeEqual(a,b)) return null;
  return nonce;
}
function ensureAdVisitor():string {
  const existing=getCookie(AD_VISITOR_COOKIE);
  const verified=existing ? verifyAdVisitor(existing) : null;
  if(verified) return verified;
  const nonce=randomBytes(24).toString("base64url");
  const value=`${nonce}.${signAdVisitor(nonce)}`;
  const secure=!isWorkspacePreview();
  setResponseHeader("Set-Cookie", `${AD_VISITOR_COOKIE}=${value}; Max-Age=${AD_VISITOR_MAX_AGE}; Path=/; SameSite=Lax${secure?"; Secure":""}; HttpOnly`);
  return nonce;
}

export const loadHomepageMerchandising = createServerFn({ method:"GET" })
  .validator(z.object({ city:z.string().trim().min(2).max(80).optional() }).optional())
  .handler(async ({data}) => {
    ensureAdVisitor();
    await enforceRateLimit("homepage-merchandising", {windowSeconds:60,maxRequests:120});
    const sql=await getDiscoverySql(); const city=data?.city?.trim() || null;
    const configs=await sql.query<any>(`select section_key,title,eyebrow,priority,max_items,mobile_visible,desktop_visible from homepage_sections where active=true order by priority,section_key`);
    const result: HomepageSection[]=[];
    for (const section of configs) {
      let rows:any[]=[];
      if (section.section_key==='flash_sales') {
        rows=await sql.query<any>(`${productSelect.replace('p.stock,exists(',"coalesce((select pv.price from product_variants pv where pv.id=fsi.variant_id and pv.product_id=p.id and pv.status='active' and pv.stock>0),p.price)::text as variant_original_price,fsi.sale_price::text as sale_price,fs.ends_at::text as sale_ends_at,p.stock,exists(")} join flash_sale_items fsi on fsi.product_id=p.id and ((fsi.variant_id is not null and exists(select 1 from product_variants pv where pv.id=fsi.variant_id and pv.product_id=p.id and pv.status='active' and pv.stock>0)) or (fsi.variant_id is null and not exists(select 1 from product_variants pv where pv.product_id=p.id and pv.status='active'))) join flash_sales fs on fs.id=fsi.flash_sale_id where fs.status='active' and fs.starts_at<=now() and fs.ends_at>now() and p.status='active' and p.stock>0 and (p.subcategory is null or cs.active=true) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections bc on bc.id=o.connection_id where o.product_id=p.id and o.status='active' and bc.status='active' and o.last_seen_at>=now()-make_interval(secs=>bc.stale_after_seconds))) order by fs.starts_at asc, fsi.sale_price asc limit $1`,[section.max_items]);
        // One product card per sale, picking the least expensive eligible sale item.
        const chosen=new Map<string,any>();
        for(const row of rows){const prev=chosen.get(row.id);if(!prev||Number(row.sale_price)<Number(prev.sale_price))chosen.set(row.id,row);}
        rows=[...chosen.values()].slice(0,section.max_items).map(r=>({...r,original_price:r.variant_original_price ?? r.price,price:r.sale_price ?? r.price}));
      } else if (section.section_key==='sponsored_ads' || section.section_key==='food_spotlight') {
        const placement=section.section_key;
        const args:any[]=[placement,section.max_items]; let cityClause='';
        if(city){args.push(city);cityClause=` and (c.target_city is null or lower(c.target_city)=lower($${args.length}))`;}
        rows=await sql.query<any>(`select c.id ad_id,c.title ad_title,c.subtitle ad_subtitle,c.destination_type,c.destination_id,p.id,p.merchant_id,m.name as merchant_name,m.neighborhood,m.city,p.name,p.category,p.subcategory,p.brand,p.model,p.sku,p.condition,p.warranty_months,p.fulfillment_type,p.status,p.returnable,p.return_window_days,p.attributes,p.financing_eligible,p.financing_min_amount,p.financing_max_amount,p.listing_type,(coalesce((select min(vp.price) from product_variants vp where vp.product_id=p.id and vp.status='active' and vp.stock>0),(select min(vp.price) from product_variants vp where vp.product_id=p.id and vp.status='active'),p.price))::text as price,p.stock,exists(select 1 from product_variants pv where pv.product_id=p.id and pv.status='active' and pv.stock>0) has_variants,p.description,p.image_path,(select round(avg(r.rating)::numeric,2)::text from reviews r where r.product_id=p.id) as avg_rating,(select count(*)::int from reviews r where r.product_id=p.id) as review_count,p.meal_type,p.cuisine,p.prep_minutes,p.guests,m.verified,m.lat,m.lon,m.address as merchant_address from homepage_ad_campaigns c join products p on p.id=c.product_id join merchants m on m.id=p.merchant_id and m.status='active' and m.verified=true join category_taxonomy ct on ct.category_key=p.category and ct.active=true left join category_subcategories cs on cs.category_key=p.category and cs.subcategory_key=p.subcategory where c.placement=$1 and c.status in ('active','scheduled') and c.starts_at<=now() and c.ends_at>now() and p.status='active' and p.stock>0 and (p.subcategory is null or cs.active=true) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections bc on bc.id=o.connection_id where o.product_id=p.id and o.status='active' and bc.status='active' and o.last_seen_at>=now()-make_interval(secs=>bc.stale_after_seconds))) and m.status='active' and m.verified=true ${cityClause} and (c.max_impressions is null or c.impression_count<c.max_impressions) and (c.target_category is null or lower(c.target_category)=lower(p.category)) and (c.placement <> 'food_spotlight' or p.listing_type='food') order by c.priority,c.created_at desc limit $2`,args);
      } else if (section.section_key==='new_arrivals') {
        rows=await sql.query<any>(`${productSelect} where p.status='active' and p.stock>0 and (p.subcategory is null or cs.active=true) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections bc on bc.id=o.connection_id where o.product_id=p.id and o.status='active' and bc.status='active' and o.last_seen_at>=now()-make_interval(secs=>bc.stale_after_seconds))) order by p.created_at desc limit $1`,[section.max_items]);
      } else if (section.section_key==='top_sellers') {
        rows=await sql.query<any>(`${productSelect} join (select oi.product_id,sum(oi.quantity)::bigint sold from order_items oi join orders o on o.id=oi.order_id where o.status in ('paid','confirmed','fulfilling','shipped','delivered','completed') and (o.status in ('delivered','completed') or exists(select 1 from payments pay where pay.order_id=o.id and pay.status='completed')) and not exists(select 1 from merchant_accounts ma where ma.merchant_id=o.merchant_id and ma.user_id=o.user_id) and o.created_at>now()-interval '90 days' group by oi.product_id) s on s.product_id=p.id where p.status='active' and p.stock>0 and (p.subcategory is null or cs.active=true) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections bc on bc.id=o.connection_id where o.product_id=p.id and o.status='active' and bc.status='active' and o.last_seen_at>=now()-make_interval(secs=>bc.stale_after_seconds))) order by s.sold desc,p.created_at desc limit $1`,[section.max_items]);
      } else if (section.section_key==='deals') {
        rows=await sql.query<any>(`${productSelect} where p.status='active' and p.stock>0 and (p.subcategory is null or cs.active=true) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections bc on bc.id=o.connection_id where o.product_id=p.id and o.status='active' and bc.status='active' and o.last_seen_at>=now()-make_interval(secs=>bc.stale_after_seconds))) and p.attributes ? 'sale_price' order by p.created_at desc limit $1`,[section.max_items]);
      } else if (section.section_key==='official_stores') {
        rows=await sql.query<any>(`${productSelect} where p.status='active' and p.stock>0 and (p.subcategory is null or cs.active=true) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections bc on bc.id=o.connection_id where o.product_id=p.id and o.status='active' and bc.status='active' and o.last_seen_at>=now()-make_interval(secs=>bc.stale_after_seconds))) and m.verified=true and m.tier in ('official','enterprise') order by m.tier desc,p.created_at desc limit $1`,[section.max_items]);
      }
      result.push({key:section.section_key,title:section.title,eyebrow:section.eyebrow,priority:section.priority,maxItems:section.max_items,mobileVisible:section.mobile_visible,desktopVisible:section.desktop_visible,items:rows.map((r:any)=>({...rowToProduct(r),...(r.ad_id?{sponsored:true,adId:r.ad_id,adTitle:r.ad_title,adSubtitle:r.ad_subtitle,destinationType:r.destination_type,destinationId:r.destination_id}:{}),...(r.original_price?{originalPrice:String(r.original_price)}:{}),...(r.sale_ends_at?{saleEndsAt:String(r.sale_ends_at)}:{})}))});
    }
    return result;
  });

const campaignSchema=z.object({merchantId:z.string().trim().min(1).max(128),productId:z.string().trim().min(1).max(128),name:z.string().trim().min(2).max(120),title:z.string().trim().min(2).max(120),subtitle:z.string().trim().max(180).optional(),imagePath:z.string().trim().max(500).optional(),startsAt:z.string().datetime(),endsAt:z.string().datetime(),targetCity:z.string().trim().min(2).max(80).optional(),priority:z.number().int().min(0).max(10000).default(100),placement:z.enum(['sponsored_ads','food_spotlight']).default('sponsored_ads')});
export const createHomepageAdCampaign=createServerFn({method:'POST'}).middleware([authMiddleware]).validator(campaignSchema).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context); await requireMerchantAccessForUserId(data.merchantId,userId); await requireFreshSession(); await enforceRateLimit('homepage-ad-create',{windowSeconds:60,maxRequests:10,subject:userId});
  const sql=await getSql(); const id=`had_${randomUUID().replaceAll('-','')}`;
  await sql.query(`insert into homepage_ad_campaigns(id,merchant_id,product_id,name,title,subtitle,image_path,destination_type,destination_id,placement,status,starts_at,ends_at,target_city,priority,created_by) select $1,$2,p.id,$3,$4,$5,$6,'product',p.id,$7,'pending_review',$8,$9,$10,$11,$12 from products p where p.id=$13 and p.merchant_id=$2 and p.status='active' and ($7 <> 'food_spotlight' or p.listing_type='food')`,[id,data.merchantId,data.name,data.title,data.subtitle??null,data.imagePath??null,data.placement,data.startsAt,data.endsAt,data.targetCity??null,data.priority,userId,data.productId]);
  const exists=await sql.query<{id:string}>(`select id from homepage_ad_campaigns where id=$1`,[id]); if(!exists[0]) throw new Error('Product not found or not eligible for advertising');
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,['merchant.homepage_ad.created','homepage_ad',id,userId,'merchant',null,'success',JSON.stringify({merchantId:data.merchantId,placement:data.placement,status:'pending_review'})]);
  return {id,status:'pending_review' as const};
});

const reviewSchema=z.object({campaignId:z.string().trim().min(1).max(128),action:z.enum(['approve','pause','reject','archive']),reason:z.string().trim().max(1000).optional()});
export const reviewHomepageAdCampaign=createServerFn({method:'POST'}).middleware([authMiddleware]).validator(reviewSchema).handler(async({data,context})=>{
  const adminId=getAuthenticatedUserId(context); await requireAdminForUserId(adminId); await requireFreshSession(); await enforceRateLimit('homepage-ad-review',{windowSeconds:60,maxRequests:30,subject:adminId}); const sql=await getSql();
  const rows=await sql.query<{id:string,status:string}>(`update homepage_ad_campaigns set status=case when $2='approve' then case when starts_at<=now() and ends_at>now() then 'active' else 'scheduled' end when $2='pause' then 'paused' when $2='reject' then 'rejected' else 'archived' end,reviewed_by=$3,reviewed_at=now(),rejection_reason=case when $2='reject' then $4 else null end,updated_at=now() where id=$1 returning id,status`,[data.campaignId,data.action,adminId,data.reason??null]); if(!rows[0]) throw new Error('Campaign not found');
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,['admin.homepage_ad.reviewed','homepage_ad',data.campaignId,adminId,'admin',null,'success',JSON.stringify({action:data.action,reason:data.reason??null})]); return {status:rows[0].status};
});

export const recordHomepageAdEvent=createServerFn({method:'POST'}).validator(z.object({eventId:z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),campaignId:z.string().min(1).max(128),eventType:z.enum(['impression','click'])})).handler(async({data})=>{
  assertSameSiteRequest();
  const visitor=ensureAdVisitor();
  // Layered abuse controls; the database additionally requires a recent impression before counting a click.
  await enforceRateLimit('homepage-ad-event-ip',{windowSeconds:60,maxRequests:30});
  await enforceRateLimit('homepage-ad-event-campaign',{windowSeconds:60,maxRequests:12,subject:data.campaignId});
  await enforceRateLimit('homepage-ad-event-visitor',{windowSeconds:60,maxRequests:20,subject:visitor});
  const sql=await getSql();
  const rows=await sql.query<{result:any}>(`select record_homepage_ad_event($1,$2,$3,$4) result`,[data.eventId,data.campaignId,data.eventType,visitor]);
  return rows[0]?.result ?? {recorded:false};
});
