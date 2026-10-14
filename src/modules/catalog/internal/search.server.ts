import {EIDE_VERSION} from './eide/version';
import { exposureRequest, signExposure } from './eide/attribution.server';
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getDiscoverySql as getSql } from "@/lib/db";
import { z } from "zod";
import { env } from "@/lib/env.server";
import { normalizeDiscoveryQuery, meaningfulTokens } from "./eide/intelligence";
import { buildQueryPlan } from "./eide/query-plan";
import { loadDiscoveryMetadata } from "./eide/metadata.server";

const SEARCH_VERSION = EIDE_VERSION;
const MAX_LIMIT=60, TTL=900;
// Small in-process optimization for one-VPS deployment. Only public aggregate
// counts/facets are cached; neither signed receipts nor personalized hits are.
// A catalog-revision change gives each result a different key.
type FacetAggregate={counts:Array<{total:string}>;facetRows:Array<{facet:string;value:string;count:string}>};
const FACET_CACHE_TTL_MS=20_000;
const FACET_CACHE_LIMIT=64;
const facetCache=new Map<string,{expires:number;value:FacetAggregate}>();

// Do not silently accept a partial location: it would produce unexpectedly global results.
const searchInputSchema=z.object({
  q:z.string().trim().max(120).default(""),category:z.string().trim().max(120).optional(),subcategory:z.string().trim().max(120).optional(),
  brand:z.string().trim().max(120).optional(),model:z.string().trim().max(120).optional(),merchantId:z.string().trim().max(128).optional(),
  lat:z.number().finite().min(-90).max(90).optional(),lon:z.number().finite().min(-180).max(180).optional(),radiusKm:z.number().finite().min(3).max(100).optional(),
  listingType:z.enum(["product","food","stay"]).optional(),condition:z.enum(["new","refurbished","used","open_box"]).optional(),
  minPrice:z.number().finite().min(0).optional(),maxPrice:z.number().finite().min(0).optional(),inStock:z.boolean().default(true),
  sort:z.enum(["relevance","price_asc","price_desc","newest"]).default("relevance"),limit:z.number().int().min(1).max(MAX_LIMIT).default(40),
  cursor:z.string().max(2048).optional(),
});
export type SearchHit={id:string;name:string;merchantName:string;merchantId?:string;category:string;subcategory?:string|null;brand?:string|null;model?:string|null;sku?:string|null;price:string;currency:string;stock?:number;imagePath:string|null;condition?:string;
  attributionReceipt?:string;relevanceScore?:number;intelligenceScore?:number;rankingSignals?:{merchantConfidence:number;conversionQuality:number;trustedCommerce:number;popularity:number;trendMomentum:number;freshness:number;inventoryHealth:number;explorationBonus:number}};
export type SearchFacet={value:string;count:number};
export type SearchResponse={source:"postgres"|"typesense";searchVersion:string;query:string;interpretedQuery:{identifier?:string;tokens:string[];effectiveQuery?:string;expandedTerms?:string[][];attributes?:{key:string;value:string;hard:boolean}[];degraded?:boolean};interpretedFilters?:Record<string,string|number|boolean|null>;hits:SearchHit[];total:number;totalExact?:boolean;facetsSampled?:boolean;nextCursor:string|null;facets:Record<string,SearchFacet[]>;appliedFilters:Record<string,string|number|boolean|null>};
type Cursor={catalogRevision:string;featureRevision:number|null;seen:number;v:string;fingerprint:string;sort:string;lane:number;key:number;score:number;id:string;exp:number;rankedAt:number;mode:"features"|"neutral"};
function secret(){const s=env("SEARCH_CURSOR_SECRET")||env("BETTER_AUTH_SECRET");if(s){if(process.env.NODE_ENV==="production"&&s.length<32)throw new Error("Search signing secret must contain at least 32 characters");return s;}if(process.env.NODE_ENV==="production")throw new Error("Search signing secret required");return "development-search-cursor-secret-change-me";}
function sign(cursor:Cursor){const body=Buffer.from(JSON.stringify(cursor)).toString("base64url");return body+"."+createHmac("sha256",secret()).update(body).digest("base64url");}
function parse(value:string|undefined):Cursor|null{
  if(!value)return null;
  const parts=value.split('.');if(parts.length!==2)return null;
  const [body,sig]=parts;const expected=createHmac('sha256',secret()).update(body).digest('base64url');
  if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
  try{const c=JSON.parse(Buffer.from(body,'base64url').toString()) as Cursor;
    if(typeof c.catalogRevision!=='string'||!/^[a-f0-9]{64}$/.test(c.catalogRevision))return null;
    if(c.featureRevision!==null&&(!Number.isSafeInteger(c.featureRevision)||c.featureRevision<0))return null;
    if(!Number.isSafeInteger(c.seen)||c.seen<0||c.seen>10000000)return null;
    if(c.v!==SEARCH_VERSION||typeof c.id!=="string"||!c.id||c.id.length>128||typeof c.fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(c.fingerprint))return null;
    if(!['relevance','price_asc','price_desc','newest'].includes(c.sort)||!['features','neutral'].includes(c.mode))return null;
    if(![c.lane,c.key,c.score,c.exp,c.rankedAt].every(Number.isFinite)||c.exp<=Date.now()/1000||c.exp>Date.now()/1000+TTL+1||c.rankedAt>Date.now()||c.rankedAt<Date.now()-TTL*1000)return null;
    return c;
  }catch{return null;}
}
function identifier(q:string){const raw=q.normalize('NFKC').trim().toLowerCase();const compact=raw.replace(/[\s-]/g,'');if(/^(?:\d{8}|\d{10}|\d{12,15})$/.test(compact))return compact;
  return /^[a-z0-9][a-z0-9._/-]{2,79}$/i.test(raw)&&/\d/.test(raw)&&/[a-z]/i.test(raw)?raw:undefined;}

export async function searchProducts(input:string|z.input<typeof searchInputSchema>,legacyLimit=40,options:{includeDiagnostics?:boolean}={}):Promise<SearchResponse>{
  const data=searchInputSchema.parse(typeof input==='string'?{q:input,limit:legacyLimit}:input);
  if((data.lat==null)!==(data.lon==null))throw new Error("invalid location: both lat and lon are required");
  if(data.minPrice!=null&&data.maxPrice!=null&&data.minPrice>data.maxPrice)throw new Error('invalid price range');
  const cursor=parse(data.cursor);if(data.cursor&&!cursor)throw new Error('invalid or expired search cursor');
  const sql=await getSql();
  // Two indexed singleton/top-dirty reads detect score and live catalog changes.
  const revision=async()=>{try{const rows=await sql.query<{revision:string;dirty:string}>(`select revision::text,
    (select revision::text from eide_catalog_revision where singleton=true) dirty
    from eide_ranking_revision where singleton=true`);const value=Number(rows[0]?.revision);
    return Number.isSafeInteger(value)&&value>=0&&rows[0]?.dirty!=null?{featureRevision:value,catalogRevision:createHash('sha256').update(rows[0].dirty).digest('hex')}:null;
  }catch{return null;}};
  const initialRevision=await revision();const catalogRevision=initialRevision?.catalogRevision??null;
  if(cursor&&(catalogRevision==null||cursor.catalogRevision!==catalogRevision))throw new Error('Search catalog changed; restart search results.');
  let featureRevision=cursor?.mode==='neutral'?null:initialRevision?.featureRevision??null;
  if(cursor?.mode==='features'&&(featureRevision==null||cursor.featureRevision!==featureRevision))throw new Error('Search ranking refreshed; restart search results.');
  const identity=identifier(data.q);
  const metadata=await loadDiscoveryMetadata(sql,data.q,data.category,data.subcategory);
  const plan=buildQueryPlan(data.q,metadata,data.sort,data.category,data.subcategory,identity);
  const fingerprint=createHash('sha256').update(JSON.stringify({...data,cursor:undefined,limit:undefined,q:undefined,interpretation:plan.hash})).digest('hex');
  if(cursor&&(cursor.fingerprint!==fingerprint||cursor.sort!==plan.effectiveSort))throw new Error('search cursor does not match interpreted query');
  const rankedAt=cursor?.rankedAt??Date.now();
  const values:unknown[]=[],types:string[]=[];
  const add=(v:unknown,type='text')=>{values.push(v);types.push(type);return `$${values.length}::${type}`;};
  const where=["p.status='active'","m.status='active'","m.verified=true","exists(select 1 from category_taxonomy c where c.category_key=p.category and c.active=true)","(p.subcategory is null or exists(select 1 from category_subcategories s where s.category_key=p.category and s.subcategory_key=p.subcategory and s.active=true))","(p.catalog_source<>'enterprise_api' or exists(select 1 from brand_integration_offers o join brand_integration_connections c on c.id=o.connection_id where o.product_id=p.id and o.status='active' and c.status='active' and o.last_seen_at>=now()-make_interval(secs=>c.stale_after_seconds)))"];
  if(data.inStock||plan.availability)where.push("(p.stock>0 and (not exists(select 1 from product_variants pv0 where pv0.product_id=p.id and pv0.status='active') or exists(select 1 from product_variants pv1 where pv1.product_id=p.id and pv1.status='active' and pv1.stock>0)))");
  const original=normalizeDiscoveryQuery(plan.lexical);
  const query=add(original);
  const time=add(new Date(rankedAt).toISOString(),'timestamptz');
  if(plan.category)where.push(`p.category=${add(plan.category)}`);
  if(plan.subcategory){const sub=add(plan.subcategory);const aliases=metadata.taxonomy.filter(a=>a.category===plan.category&&a.subcategory===plan.subcategory).map(a=>a.alias);
    const categoryQuery=aliases.map(a=>`plainto_tsquery('simple',${add(a)})`).join(' || ')||`plainto_tsquery('simple',${add(plan.subcategory)})`;
    where.push(`(p.subcategory=${sub} or (p.subcategory is null and p.search_vector@@(${categoryQuery})))`);
  }
  for(const [field,value] of [['brand',data.brand??plan.brand],['model',data.model],['merchant_id',data.merchantId],['listing_type',data.listingType],['condition',data.condition]] as const){if(value)where.push(field==='brand'||field==='model'?`lower(p.${field})=lower(${add(value)})`:`p.${field}=${add(value)}`);}
  // One source of truth for price filters, sorting, scoring, and displayed cards.
  const listingPrice=`coalesce((select min(vp.price) from product_variants vp where vp.product_id=p.id and vp.status='active' and vp.stock>0),(select min(vp.price) from product_variants vp where vp.product_id=p.id and vp.status='active'),p.price)`;
  for(const [op,value] of [['>=',data.minPrice],['<=',data.maxPrice],['>=',plan.hardFloor],['<=',plan.hardCeiling]] as const)if(value!=null)where.push(`(${listingPrice})${op}${add(value,'numeric')}`);
  if(data.lat!=null&&data.lon!=null){const lat=add(data.lat,'double precision'),lon=add(data.lon,'double precision'),radius=add(data.radiusKm??100,'double precision');where.push(`6371*2*asin(sqrt(least(1,greatest(0,power(sin(radians(m.lat-${lat})/2),2)+cos(radians(${lat}))*cos(radians(m.lat))*power(sin(radians(m.lon-${lon})/2),2)))))<=${radius}`);}
  const groups=plan.groups;
  const tsOriginal=groups.length?groups.map(g=>`plainto_tsquery('simple',${add(g[0])})`).join(' && '):null;
  const tsExpanded=groups.length?groups.map(g=>`(${g.map(t=>`plainto_tsquery('simple',${add(t)})`).join(' || ')})`).join(' && '):null;
  const exactIdentifier=identity?`(lower(coalesce(p.sku,''))=${add(identity)} or lower(coalesce(p.model,''))=${add(identity)} or lower(coalesce(p.canonical_product_key,''))=${add(identity)} or exists(select 1 from product_identifiers pi where pi.product_id=p.id and pi.normalized_value=regexp_replace(${add(identity)},'[^a-z0-9]','','g')))`:'false';
  const originalMatch=tsOriginal?`p.search_vector@@(${tsOriginal})`:'false';
  const expandedMatch=tsExpanded?`p.search_vector@@(${tsExpanded})`:'false';
  const partial=original?`p.normalized_name like '%'||replace(replace(replace(${query},'\\','\\\\'),'%','\\%'),'_','\\_')||'%' escape '\\'`:'false';
  const predicate=groups.length||identity?`(${exactIdentifier} or ${originalMatch} or ${expandedMatch} or ${partial})`:'true';
  where.push(predicate);
  const lex=groups.length||identity?`greatest(case when ${exactIdentifier} then 1 else 0 end,case when lower(p.name)=${query} then .98 else 0 end,case when lower(coalesce(p.model,''))=${query} then .96 else 0 end,case when lower(coalesce(p.brand,''))=${query} then .92 else 0 end,case when ${partial} then .65 else 0 end,case when ${originalMatch} then .4+least(.2,ts_rank_cd(p.search_vector,(${tsOriginal??"plainto_tsquery('simple','')"}))*4) else 0 end,case when ${expandedMatch} then .1+least(.2,ts_rank_cd(p.search_vector,(${tsExpanded??"plainto_tsquery('simple','')"}))*4) else 0 end)`:'.5';
  const hardProductAttributes:string[]=[];
  const attributeMatches=plan.attributes.map(a=>{
    const v=add(a.value),unit=add(a.unit);const conditions=a.keys.map(key=>`eide_normalize_attribute(p.attributes->>${add(key)},${unit})=${v}`);
    const productMatch=`(${conditions.join(' or ')})`;
    const variantMatch=`exists(select 1 from product_variants pv where pv.product_id=p.id and pv.status='active' and pv.stock>0 and (${conditions.join(' or ').replaceAll('p.attributes','pv.attributes')}))`;
    const match=`(${productMatch} or ${variantMatch})`;if(a.hard)hardProductAttributes.push(productMatch);return match;
  });
  if(hardProductAttributes.length){const combined=hardProductAttributes.join(' and ');where.push(`((${combined}) or exists(select 1 from product_variants pv where pv.product_id=p.id and pv.status='active' and pv.stock>0 and (${combined.replaceAll('p.attributes','pv.attributes')})))`);}
  const attrScore=attributeMatches.length?`(${attributeMatches.map(m=>`case when ${m} then 1 else 0 end`).join('+')})::double precision/${attributeMatches.length}`:'0';
  const fresh=`ef.feature_stale_after>=${time} and ef.model_version='${SEARCH_VERSION}'`;
  const signal=(column:string,neutral:number)=>`case when ${fresh} and coalesce(ef.${column}::text,'') not in ('NaN','Infinity','-Infinity') then least(1,greatest(0,coalesce(ef.${column},${neutral}))) else ${neutral} end`;
  const merchant=signal('merchant_confidence',.5),conversion=signal('conversion_quality',.5),commerce=signal('trusted_commerce_score',0),popularity=signal('popularity',0),trend=signal('trend_momentum',.5),exploration=signal('exploration_bonus',0),freshness=signal('freshness',.5),inventory=signal('inventory_health',.5);
  const quality=`(.58+.10*${merchant}+.07*${conversion}+.06*${commerce}+.01*${popularity}+.02*(${trend}-.5)+.04*${freshness}+.04*${inventory}+.03*${exploration})`;
  const budget=plan.softBudget!=null&&plan.category?add(plan.softBudget,'numeric'):null;
  // Do not equate low absolute price with value across unrelated product cohorts.
  // Until a trustworthy comparable-offer benchmark exists, value intent rewards
  // service/commerce quality only; explicit/soft budgets supply the price signal.
  const valueUtility=plan.valueSeeking?`(1+.04*(${merchant}*.5+${conversion}*.3+${commerce}*.2))`:'1';
  const budgetUtility=budget?`(1+.04/(1+greatest(0,((${listingPrice})-${budget})/greatest(1,${budget}))))`:'1';
  const baseScore=`(1000*(${lex})*${quality}*(1+.04*(${attrScore}))*${valueUtility}*${budgetUtility})`;
  const baseWhere=where.join(' and ');
  const baseValues=[...values];const bound=values.map((_,i)=>`$${i+1}::${types[i]} as b${i}`).join(',');
  // Explicit immutable bindings keep count/facet parameter types valid when only
  // ranking references a budget or signal parameter.
  const bindingCTE=`input as (select ${bound})`;
  const sort=plan.effectiveSort;const key=sort==='newest'?'extract(epoch from p.created_at)::double precision':sort==='price_asc'||sort==='price_desc'?`(${listingPrice})::double precision`:'0::double precision';
  let after='';
  if(cursor){const lane=add(cursor.lane,'integer'),keyParam=add(cursor.key,'double precision'),score=add(cursor.score,'double precision'),id=add(cursor.id);
    if(sort==='relevance')after=`where (_lane<${lane} or (_lane=${lane} and (_score<${score} or (_score=${score} and id>${id})))) and ${keyParam} is not null`;
    else {const op=sort==='price_asc'?'>':'<';after=`where (_key${op}${keyParam} or (_key=${keyParam} and (_lane<${lane} or (_lane=${lane} and (_score<${score} or (_score=${score} and id>${id})))))`;}
  }
  const limit=add(data.limit+1,'integer');
  const order=sort==='relevance'?'_lane desc,_score desc,id asc':`_key ${sort==='price_asc'?'asc':'desc'},_lane desc,_score desc,id asc`;
  let mode:Cursor['mode']=cursor?.mode??(featureRevision==null?'neutral':'features');
  const neutral="left join (select null::text product_id,null::text model_version,null::timestamptz feature_stale_after,null::double precision merchant_confidence,null::double precision conversion_quality,null::double precision trusted_commerce_score,null::double precision popularity,null::double precision exploration_bonus,null::double precision trend_momentum,null::double precision freshness,null::double precision inventory_health) ef on false";
  // Diversity only changes order within the same lexical relevance lane. Duplicate
  // penalties are merchant-scoped so legitimate competing offers are not penalized.
  // Bound the expensive feature joins, diversity windows and scoring to a
  // deterministic candidate pool. Lexical queries prioritize full-text matches;
  // browse queries prioritize recently updated inventory. This is deliberately
  // a retrieval cap, not an exact global ranking guarantee.
  const candidateCap=add(Math.max(2000,data.limit*50),'integer');
  const candidateOrder=sort==='price_asc'||sort==='price_desc'
    ? `(${listingPrice}) ${sort==='price_asc'?'asc':'desc'} nulls last,p.id asc`
    : sort==='newest' ? 'p.created_at desc,p.id asc'
    : tsOriginal ? `case when p.search_vector @@ (${tsOriginal}) then 1 else 0 end desc, ts_rank_cd(p.search_vector,(${tsOriginal})) desc,p.id asc`
    : 'p.created_at desc,p.id asc';
  const statement=`with ${bindingCTE}, candidate_ids as (
    select p.id from products p join merchants m on m.id=p.merchant_id
    where ${baseWhere} order by ${candidateOrder} limit ${candidateCap}
  ), eligible as (
    select p.id,p.name,m.name as "merchantName",p.merchant_id as "merchantId",p.category,p.subcategory,p.brand,p.model,p.sku,(${listingPrice})::text as price,p.currency,p.stock,p.image_path as "imagePath",p.condition,p.attributes,p.canonical_product_key as _canonical_key,
      (case when (${lex}) >= 0.85 then 3 when (${lex}) >= 0.45 then 2 when (${lex}) > 0 then 1 else 0 end)::integer _lane,${key} _key,${baseScore}::double precision _base_score,
      ${merchant} _merchant,${conversion} _conversion,${commerce} _commerce,${popularity} _popularity,${trend} _trend,${exploration} _exploration,${freshness} _freshness,${inventory} _inventory
    from candidate_ids ci join products p on p.id=ci.id join merchants m on m.id=p.merchant_id left join eide_product_features ef on ef.product_id=p.id where ${baseWhere}
  ), positions as (select e.*,row_number() over(partition by "merchantId",_lane order by _base_score desc,id asc) _merchant_pos,
    row_number() over(partition by "merchantId",coalesce(nullif(_canonical_key,''),id),model,condition,attributes,_lane order by _base_score desc,id asc) _canonical_pos from eligible e),
  ranked as (select e.*,(_base_score*(1-least(.40,.14*greatest(0,_merchant_pos-3)+.12*greatest(0,_canonical_pos-1))))::double precision _score from positions e)
  select * from ranked ${after} order by ${order} limit ${limit}`;
  const run=()=>sql.query<SearchHit&Record<string,unknown>>(mode==='neutral'?statement.replace('left join eide_product_features ef on ef.product_id=p.id',neutral):statement,values);
  let rows;
  try{rows=await run();}catch(error){if(!['42P01','42703'].includes((error as {code?:string}).code??''))throw error;
    if(cursor)throw new Error('Ranking changed; restart search without the cursor');mode='neutral';rows=await run();}
  const afterRevision=await revision();
  if(catalogRevision!==afterRevision?.catalogRevision&&catalogRevision!=null)throw new Error('Search catalog changed; restart search results.');
  if(mode==='features'&&afterRevision?.featureRevision!==featureRevision){
    if(cursor)throw new Error('Search ranking refreshed; restart search results.');
    mode='neutral';featureRevision=null;rows=await run();
  }
  if(mode==='neutral')featureRevision=null;
  const page=rows.slice(0,data.limit),last=page.at(-1);
  const nextCursor=rows.length>data.limit&&last&&catalogRevision?sign({catalogRevision,featureRevision,seen:(cursor?.seen??0)+page.length,v:SEARCH_VERSION,fingerprint,sort,lane:Number(last._lane),key:Number(last._key),score:Number(last._score),id:last.id,exp:Math.floor(rankedAt/1000)+TTL,rankedAt,mode}):null;
  const request=exposureRequest();
  const hits:SearchHit[]=page.map((row,index)=>{
    const hit=Object.fromEntries(Object.entries(row).filter(([name])=>!name.startsWith('_')&&name!=='attributes')) as SearchHit;
    if((cursor?.seen??0)+index<1000)hit.attributionReceipt=signExposure({v:SEARCH_VERSION,request,queryHash:createHmac('sha256',secret()).update(fingerprint).digest('hex'),productId:hit.id,position:(cursor?.seen??0)+index+1,exp:Math.floor(Date.now()/1000)+TTL},createHash('sha256').update(secret()).digest('hex'));
    if(options.includeDiagnostics){hit.relevanceScore=Number(row._lane);hit.intelligenceScore=Number(row._score);hit.rankingSignals={merchantConfidence:Number(row._merchant),conversionQuality:Number(row._conversion),trustedCommerce:Number(row._commerce),popularity:Number(row._popularity),trendMomentum:Number(row._trend),freshness:Number(row._freshness),inventoryHealth:Number(row._inventory),explorationBonus:Number(row._exploration)};}
    return hit;
  });
  const cacheKey=`${catalogRevision??'unversioned'}:${fingerprint}`;
  const nowMs=Date.now();
  const cached=facetCache.get(cacheKey);
  let aggregates:FacetAggregate;
  if(cached&&cached.expires>nowMs){
    aggregates=cached.value;
  }else{
    const [counts,facetRows]=await Promise.all([
      sql.query<{total:string}>(`with ${bindingCTE} select count(*)::text as total from (select 1 from products p join merchants m on m.id=p.merchant_id where ${baseWhere} limit 5001) candidate`,baseValues).catch(()=>[]),
      sql.query<{facet:string;value:string;count:string}>(`with ${bindingCTE}, candidate as (
      select p.category,p.subcategory,p.brand,p.condition,p.attributes from products p join merchants m on m.id=p.merchant_id where ${baseWhere} order by p.id limit 5000),
      facets as (select 'category' facet,category value from candidate union all select 'subcategory',subcategory from candidate union all select 'brand',brand from candidate union all select 'condition',condition from candidate
      union all select 'attribute:'||e.key,e.value from candidate cross join lateral jsonb_each_text(case when jsonb_typeof(attributes)='object' then attributes else '{}'::jsonb end)e)
      select facet,value,count(*)::text count from facets where value is not null and value<>'' group by facet,value order by facet,count(*) desc,value limit 300`,baseValues).catch(()=>[]),
    ]);
    aggregates={counts,facetRows};
    // Avoid retaining unbounded search queries on a long-running VPS.
    if(catalogRevision){
      if(facetCache.size>=FACET_CACHE_LIMIT)facetCache.delete(facetCache.keys().next().value!);
      facetCache.set(cacheKey,{expires:nowMs+FACET_CACHE_TTL_MS,value:aggregates});
    }
  }
  const {counts,facetRows}=aggregates;
  const total=Number(counts[0]?.total??hits.length);const facets:Record<string,SearchFacet[]>={};for(const row of facetRows)(facets[row.facet]??=[]).push({value:row.value,count:Number(row.count)});
  const interpretedFilters={category:plan.category,subcategory:plan.subcategory,brand:plan.brand,minPrice:plan.hardFloor,maxPrice:plan.hardCeiling,budgetCeiling:plan.softBudget,availability:plan.availability,newest:plan.effectiveSort==='newest',effectiveSort:plan.effectiveSort};
  if(!cursor&&data.q)await sql.query(`insert into marketplace_search_events(query_hash,result_count,zero_result,filter_fingerprint,search_version) values($1,$2,$3,$4,$5)`,[createHmac('sha256',secret()).update(normalizeDiscoveryQuery(data.q)).digest('hex'),total,total===0,fingerprint,SEARCH_VERSION]).catch(()=>undefined);
  return {source:'postgres',searchVersion:SEARCH_VERSION,query:data.q,interpretedQuery:{identifier:identity,tokens:meaningfulTokens(plan.lexical),effectiveQuery:plan.lexical,expandedTerms:plan.groups,attributes:plan.attributes.map(({key,value,hard})=>({key,value,hard})),degraded:metadata.degraded||mode==='neutral'},interpretedFilters,hits,total,totalExact:counts.length>0&&total<=5000,facetsSampled:counts.length===0||total>5000,nextCursor,facets,appliedFilters:{category:data.category??null,subcategory:data.subcategory??null,brand:data.brand??null,model:data.model??null,merchantId:data.merchantId??null,listingType:data.listingType??null,condition:data.condition??null,minPrice:data.minPrice??null,maxPrice:data.maxPrice??null,inStock:data.inStock,sort:data.sort}};
}
export { searchInputSchema };
