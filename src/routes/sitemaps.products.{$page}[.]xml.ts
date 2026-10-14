import { createFileRoute } from "@tanstack/react-router";
import { getDiscoverySql as getSql } from "@/lib/db";

const SHARD_SIZE=45000;
function xml(value:string){return value.replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]??c));}
function siteOrigin(){const raw=process.env.BETTER_AUTH_URL?.trim();if(!raw)throw new Error("BETTER_AUTH_URL is required");return new URL(raw).origin;}
export const Route=createFileRoute("/sitemaps/products/{$page}.xml")({server:{handlers:{GET:async({params})=>{
  const page=Number(params.page); if(!Number.isInteger(page)||page<1||page>10000)return new Response("Not found",{status:404});
  try{
    const sql=await getSql(); const offset=(page-1)*SHARD_SIZE;
    const rows=await sql.query<{id:string;updated_at:string}>(`select p.id,p.updated_at from eide_seo_pages s join products p on p.id=s.entity_key join merchants m on m.id=p.merchant_id where s.page_type='product' and s.index_decision='index' and s.calculated_at>=p.updated_at and s.calculated_at>=now()-interval '6 hours' and exists(select 1 from category_taxonomy ct where ct.category_key=p.category and ct.active=true) and (p.subcategory is null or exists(select 1 from category_subcategories cs where cs.category_key=p.category and cs.subcategory_key=p.subcategory and cs.active=true)) and (p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections c on c.id=o.connection_id where o.product_id=p.id and o.status='active' and c.status='active' and o.last_seen_at>=now()-make_interval(secs=>c.stale_after_seconds))) and p.status='active' and p.stock>0 and m.status='active' and m.verified=true order by p.id asc limit $1 offset $2`,[SHARD_SIZE,offset]);
    if(page>1&&rows.length===0)return new Response("Not found",{status:404}); const base=siteOrigin();
    const urls=rows.map(r=>`<url><loc>${xml(`${base}/products/${encodeURIComponent(r.id)}`)}</loc><lastmod>${xml(new Date(r.updated_at).toISOString())}</lastmod></url>`).join("");
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${xml(base+"/")}</loc></url>${urls}</urlset>`,{headers:{"content-type":"application/xml; charset=utf-8","cache-control":"public, max-age=900, stale-while-revalidate=3600"}});
  }catch{return new Response("Sitemap unavailable",{status:503,headers:{"cache-control":"no-store"}});}
}}}});
