import type { JsonObject } from "@/lib/db-types";
import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireCustomerForUserId, requireMerchantAccessForUserId } from "@/modules/identity/public/auth/authorization.server";
import { getSql,getDiscoverySql } from "@/lib/db";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const id = z.string().trim().min(1).max(128);
const searchQuerySchema = z.object({
  q: z.string().trim().max(120).default(""),
  category: z.string().trim().max(120).optional(),
  subcategory: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(120).optional(),
  condition:z.enum(["new","refurbished","used","open_box"]).optional(),
  minPrice: z.number().finite().min(0).optional(),
  maxPrice: z.number().finite().min(0).optional(),
  sort: z.enum(["relevance", "price_asc", "price_desc", "newest"]).default("relevance"),
});

async function requireCustomerContext(userId: string) {
  await requireCustomerForUserId(userId);
  return getSql();
}

export const toggleWishlistProduct = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ productId: id }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const sql = await requireCustomerContext(userId);
    await enforceRateLimit("wishlist-toggle", { windowSeconds: 60, maxRequests: 60, subject: userId });
    const product = await sql.query<{ id: string }>(`select p.id from products p join merchants m on m.id=p.merchant_id join category_taxonomy ct on ct.category_key=p.category and ct.active=true left join category_subcategories cs on cs.category_key=p.category and cs.subcategory_key=p.subcategory where p.id=$1 and p.status='active' and m.status='active' and m.verified=true and (p.subcategory is null or cs.active=true)`, [data.productId]);
    if (!product[0]) throw new Error("Product unavailable");
    const existing = await sql.query<{ product_id: string }>(`delete from customer_wishlist where user_id=$1 and product_id=$2 returning product_id`, [userId, data.productId]);
    if (existing[0]) return { saved: false as const };
    await sql.query(`insert into customer_wishlist(user_id,product_id) values($1,$2) on conflict do nothing`, [userId, data.productId]);
    return { saved: true as const };
  });

export const recordRecentProduct = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ productId: id }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const sql = await requireCustomerContext(userId);
    await enforceRateLimit("recent-product-view", { windowSeconds: 60, maxRequests: 120, subject: userId });
    await sql.query(`select record_customer_product_view($1,$2)`, [userId, data.productId]);
    return { recorded: true as const };
  });

export const setBackInStockSubscription = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ productId: id, active: z.boolean() }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const sql = await requireCustomerContext(userId);
    await enforceRateLimit("back-in-stock-subscription", { windowSeconds: 60, maxRequests: 30, subject: userId });
    const product = await sql.query<{ id: string; stock: number }>(`select p.id,p.stock from products p join merchants m on m.id=p.merchant_id join category_taxonomy ct on ct.category_key=p.category and ct.active=true left join category_subcategories cs on cs.category_key=p.category and cs.subcategory_key=p.subcategory where p.id=$1 and p.status='active' and m.status='active' and m.verified=true and (p.subcategory is null or cs.active=true)`, [data.productId]);
    if (!product[0]) throw new Error("Product unavailable");
    if (data.active && product[0].stock > 0) throw new Error("Product is already in stock");
    if (!data.active) {
      await sql.query(`update back_in_stock_subscriptions set status='cancelled' where user_id=$1 and product_id=$2`, [userId, data.productId]);
      return { active: false as const };
    }
    await sql.query(`insert into back_in_stock_subscriptions(user_id,product_id,status,notified_at) values($1,$2,'active',null) on conflict(user_id,product_id) do update set status='active',notified_at=null,created_at=now()`, [userId, data.productId]);
    return { active: true as const };
  });

export const saveSearch = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ name: z.string().trim().min(1).max(80), query: searchQuerySchema, notify: z.boolean().default(false) }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const sql = await requireCustomerContext(userId);
    await enforceRateLimit("saved-search-write", { windowSeconds: 60, maxRequests: 20, subject: userId });
    const savedId = `ss_${randomUUID().replaceAll("-", "")}`;
    await sql.query(`insert into saved_searches(id,user_id,name,query,notify) values($1,$2,$3,$4::jsonb,$5) on conflict(user_id,name) do update set query=excluded.query,notify=excluded.notify,updated_at=now()`, [savedId, userId, data.name, JSON.stringify(data.query), data.notify]);
    return { saved: true as const };
  });

export const deleteSavedSearch = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ id }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const sql = await requireCustomerContext(userId);
    await sql.query(`delete from saved_searches where id=$1 and user_id=$2`, [data.id, userId]);
    return { deleted: true as const };
  });

export const askProductQuestion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ productId: id, question: z.string().trim().min(5).max(1000) }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const sql = await requireCustomerContext(userId);
    await enforceRateLimit("product-question-create", { windowSeconds: 3600, maxRequests: 12, subject: userId });
    const product = await sql.query<{ id: string }>(`select p.id from products p join merchants m on m.id=p.merchant_id join category_taxonomy ct on ct.category_key=p.category and ct.active=true left join category_subcategories cs on cs.category_key=p.category and cs.subcategory_key=p.subcategory where p.id=$1 and p.status='active' and m.status='active' and m.verified=true and (p.subcategory is null or cs.active=true)`, [data.productId]);
    if (!product[0]) throw new Error("Product unavailable");
    const questionId = `pque_${randomUUID().replaceAll("-", "")}`;
    await sql.query(`insert into product_questions(id,product_id,user_id,question) values($1,$2,$3,$4)`, [questionId, data.productId, userId, data.question]);
    return { questionId };
  });

export const answerProductQuestion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ merchantId: id, questionId: id, answer: z.string().trim().min(2).max(1500) }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireMerchantAccessForUserId(data.merchantId, userId);
    await enforceRateLimit("product-question-answer", { windowSeconds: 60, maxRequests: 30, subject: userId });
    const sql = await getSql();
    const rows = await sql.query<{ result: JsonObject }>(`select answer_product_question($1,$2,$3,$4) as result`, [data.questionId, data.merchantId, userId, data.answer]);
    return rows[0]?.result ?? { status: "answered" };
  });

export const listProductQuestions = createServerFn({ method: "GET" })
  .validator(z.object({ productId: id }))
  .handler(async ({ data }) => {
    await enforceRateLimit("product-question-list", { windowSeconds: 60, maxRequests: 180 });
    const sql = await getSql();
    return sql.query<{ id: string; question: string; created_at: string; answer: string | null; answered_at: string | null }>(
      `select q.id,q.question,q.created_at,a.answer,a.created_at as answered_at
         from product_questions q left join product_answers a on a.question_id=q.id
        where q.product_id=$1 and q.status in ('published','answered')
        order by q.created_at desc limit 50`, [data.productId]);
  });

export const loadCustomerEngagement = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = getAuthenticatedUserId(context);
    const sql = await requireCustomerContext(userId);
    const [wishlist, recent, savedSearches, backInStock, loyalty] = await Promise.all([
      sql.query<{ product_id: string; name: string; price: string; image_path: string | null; stock: number }>(`select p.id product_id,p.name,p.price::text,p.image_path,p.stock from customer_wishlist w join products p on p.id=w.product_id join merchants m on m.id=p.merchant_id where w.user_id=$1 and p.status='active' and m.status='active' and m.verified=true order by w.created_at desc limit 100`, [userId]),
      sql.query<{ product_id: string; name: string; price: string; image_path: string | null; viewed_at: string }>(`select p.id product_id,p.name,p.price::text,p.image_path,r.viewed_at from customer_recent_products r join products p on p.id=r.product_id join merchants m on m.id=p.merchant_id where r.user_id=$1 and p.status='active' and m.status='active' and m.verified=true order by r.viewed_at desc limit 30`, [userId]),
      sql.query<{ id: string; name: string; query: JsonObject; notify: boolean; updated_at: string }>(`select id,name,query,notify,updated_at from saved_searches where user_id=$1 order by updated_at desc limit 50`, [userId]),
      sql.query<{ product_id: string; name: string; status: string }>(`select p.id product_id,p.name,b.status from back_in_stock_subscriptions b join products p on p.id=b.product_id where b.user_id=$1 and b.status='active' order by b.created_at desc`, [userId]),
      sql.query<{ points_balance: string }>(`select points_balance::text from customer_loyalty_accounts where user_id=$1`, [userId]),
    ]);
    return { wishlist, recent, savedSearches, backInStock, loyaltyPoints: Number(loyalty[0]?.points_balance ?? 0) };
  });

export const searchSuggestions = createServerFn({ method: "GET" })
  .validator(z.object({ q: z.string().trim().min(2).max(80) }))
  .handler(async ({ data }) => {
    await enforceRateLimit("search-suggestions", { windowSeconds: 60, maxRequests: 120 });
    const sql = await getDiscoverySql();
    const value = `${data.q.replace(/[%_\\]/g, "\\$&")}%`;
    const rows = await sql.query<{ value: string }>(
      `select value from (
         select p.name as value, 1 as rank from products p join merchants m on m.id=p.merchant_id join category_taxonomy ct on ct.category_key=p.category and ct.active=true left join category_subcategories cs on cs.category_key=p.category and cs.subcategory_key=p.subcategory where p.status='active' and p.stock>0 and m.status='active' and m.verified=true and exists(select 1 from category_taxonomy ct where ct.category_key=p.category and ct.active=true) and (p.subcategory is null or exists(select 1 from category_subcategories cs where cs.category_key=p.category and cs.subcategory_key=p.subcategory and cs.active=true)) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections c on c.id=o.connection_id where o.product_id=p.id and o.status='active' and c.status='active' and o.last_seen_at>=now()-make_interval(secs=>c.stale_after_seconds))) and (p.subcategory is null or cs.active=true) and p.name ilike $1 escape '\\'
         union all
         select p.brand as value, 2 as rank from products p join merchants m on m.id=p.merchant_id join category_taxonomy ct on ct.category_key=p.category and ct.active=true left join category_subcategories cs on cs.category_key=p.category and cs.subcategory_key=p.subcategory where p.status='active' and p.stock>0 and m.status='active' and m.verified=true and exists(select 1 from category_taxonomy ct where ct.category_key=p.category and ct.active=true) and (p.subcategory is null or exists(select 1 from category_subcategories cs where cs.category_key=p.category and cs.subcategory_key=p.subcategory and cs.active=true)) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections c on c.id=o.connection_id where o.product_id=p.id and o.status='active' and c.status='active' and o.last_seen_at>=now()-make_interval(secs=>c.stale_after_seconds))) and (p.subcategory is null or cs.active=true) and p.brand is not null and p.brand ilike $1 escape '\\'
         union all
         select s.synonym as value, 3 as rank from marketplace_search_synonyms s where s.status='active' and (s.term ilike $1 escape '\\' or s.synonym ilike $1 escape '\\')
       ) x where value is not null group by value,rank order by rank,value limit 10`, [value]);
    return rows.map((r) => r.value);
  });

export const listProductReviews = createServerFn({ method: "GET" })
  .validator(z.object({ productId: id, before: z.string().datetime().optional(), limit: z.number().int().min(1).max(50).default(20) }))
  .handler(async ({ data }) => {
    await enforceRateLimit("product-review-list", { windowSeconds: 60, maxRequests: 180 });
    const sql = await getSql();
    const rows = await sql.query<{ id:string; rating:number; body:string; created_at:string; merchant_response:string|null; response_at:string|null }>(
      `select r.id,r.rating,r.body,r.created_at,rr.body as merchant_response,rr.created_at as response_at
         from reviews r left join review_responses rr on rr.review_id=r.id
        where r.product_id=$1 and ($2::timestamptz is null or r.created_at < $2::timestamptz)
        order by r.created_at desc,r.id desc limit $3`, [data.productId, data.before ?? null, data.limit]);
    return { reviews: rows, nextBefore: rows.length === data.limit ? rows.at(-1)?.created_at ?? null : null };
  });

export const personalizedRecommendations = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ limit: z.number().int().min(1).max(20).default(12) }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const sql = await requireCustomerContext(userId);
    await enforceRateLimit("customer-recommendations", { windowSeconds: 60, maxRequests: 60, subject: userId });
    return sql.query<{ id:string; name:string; price:string; image_path:string|null; category:string; merchant_name:string }>(
      `with interests as (
         select p.category,count(*) weight from customer_recent_products r join products p on p.id=r.product_id where r.user_id=$1 group by p.category
         union all
         select p.category,count(*)*2 weight from customer_wishlist w join products p on p.id=w.product_id where w.user_id=$1 group by p.category
       ), ranked as (select category,sum(weight) weight from interests group by category)
       select p.id,p.name,p.price::text,p.image_path,p.category,m.name merchant_name
         from products p join merchants m on m.id=p.merchant_id
         left join ranked i on i.category=p.category
        where p.status='active' and p.stock>0 and m.status='active' and m.verified=true and exists(select 1 from category_taxonomy ct where ct.category_key=p.category and ct.active=true) and (p.subcategory is null or exists(select 1 from category_subcategories cs where cs.category_key=p.category and cs.subcategory_key=p.subcategory and cs.active=true)) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections c on c.id=o.connection_id where o.product_id=p.id and o.status='active' and c.status='active' and o.last_seen_at>=now()-make_interval(secs=>c.stale_after_seconds)))
          and not exists(select 1 from customer_recent_products r where r.user_id=$1 and r.product_id=p.id and r.viewed_at>now()-interval '1 day')
        order by coalesce(i.weight,0) desc,p.created_at desc,p.id asc limit $2`, [userId, data.limit]);
  });

export const recordProductEvent = createServerFn({ method: "POST" })
  .validator(z.object({ eventId: z.string().trim().min(16).max(128), productId: id, eventType: z.enum(["view","add_to_cart"]) }))
  .handler(async ({ data }) => {
    await enforceRateLimit("product-funnel-event", { windowSeconds: 60, maxRequests: 60 });
    if ((data.eventType === "view" && !data.eventId.startsWith("view_")) || (data.eventType === "add_to_cart" && !data.eventId.startsWith("cart_"))) throw new Error("invalid event id");
    const sql = await getDiscoverySql();
    await sql.query(
      `with recorded as (
         insert into marketplace_product_events(id,product_id,merchant_id,event_type)
         select $1,p.id,p.merchant_id,$3 from products p join merchants m on m.id=p.merchant_id
          where p.id=$2 and p.status='active' and m.status='active' and m.verified=true
         on conflict(id) do nothing returning product_id,event_type
       )
       insert into eide_ranking_events(event_type,product_id,model_version)
       select case when event_type='view' then 'view' else 'add_to_cart' end,product_id,'eide-v11.3' from recorded`,
      [data.eventId, data.productId, data.eventType]).catch(() => undefined);
    return { recorded: true as const };
  });

/** Exact account/product state, independent of the paginated profile read model. */
export const getCustomerProductEngagement = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ productId: id }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const sql = await requireCustomerContext(userId);
    await enforceRateLimit("product-engagement-read", { windowSeconds: 60, maxRequests: 60, subject: userId });
    const rows = await sql.query<{ saved: boolean; stockAlert: boolean }>(
      `select exists(select 1 from customer_wishlist where user_id=$1 and product_id=$2) as saved,
              exists(select 1 from back_in_stock_subscriptions where user_id=$1 and product_id=$2 and status='active') as "stockAlert"`,
      [userId, data.productId],
    );
    return rows[0] ?? { saved: false, stockAlert: false };
  });
