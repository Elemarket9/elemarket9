import { createFileRoute } from "@tanstack/react-router";
import { getDiscoverySql as getSql } from "@/lib/db";

const SHARD_SIZE = 45000;
function xml(value: string) { return value.replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&apos;" }[c] ?? c)); }
function siteOrigin() { const raw=process.env.BETTER_AUTH_URL?.trim(); if(!raw) throw new Error("BETTER_AUTH_URL is required"); return new URL(raw).origin; }

export const Route = createFileRoute("/sitemap.xml")({ server:{ handlers:{ GET:async()=>{
  try {
    const sql=await getSql();
    const rows=await sql.query<{total:string}>(`select count(*)::text total from eide_seo_pages s join products p on p.id=s.entity_key join merchants m on m.id=p.merchant_id where s.page_type='product' and s.index_decision='index' and s.calculated_at>=p.updated_at and s.calculated_at>=now()-interval '6 hours' and exists(select 1 from category_taxonomy ct where ct.category_key=p.category and ct.active=true) and (p.subcategory is null or exists(select 1 from category_subcategories cs where cs.category_key=p.category and cs.subcategory_key=p.subcategory and cs.active=true)) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections c on c.id=o.connection_id where o.product_id=p.id and o.status='active' and c.status='active' and o.last_seen_at>=now()-make_interval(secs=>c.stale_after_seconds))) and p.status='active' and p.stock>0 and m.status='active' and m.verified=true`);
    const pages=Math.max(1,Math.ceil(Number(rows[0]?.total??0)/SHARD_SIZE)); const base=siteOrigin();
    const maps=Array.from({length:pages},(_,i)=>`<sitemap><loc>${xml(`${base}/sitemaps/products/${i+1}.xml`)}</loc></sitemap>`).join("");
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${maps}</sitemapindex>`,{headers:{"content-type":"application/xml; charset=utf-8","cache-control":"public, max-age=900, stale-while-revalidate=3600"}});
  } catch { return new Response("Sitemap unavailable",{status:503,headers:{"cache-control":"no-store"}}); }
}}}});
