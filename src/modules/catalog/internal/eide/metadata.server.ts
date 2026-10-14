import type { Sql } from "@/lib/db";
import { normalizeDiscoveryQuery, meaningfulTokens, correctDiscoveryQuery, classifyQueryIntent } from "./intelligence";
import { taxonomyIntent, type DiscoveryMetadata, type AttributeDefinition, type TaxonomyAlias, type Synonym, normalizeAttributeValue } from "./query-plan";

/** Request-scoped, bounded metadata. Failures are represented in cursor interpretation. */
export async function loadDiscoveryMetadata(sql: Sql, query: string, category?: string, subcategory?: string): Promise<DiscoveryMetadata> {
  const words=meaningfulTokens(query).slice(0,12);
  const phrases=words.flatMap((_,i)=>[words[i],words.slice(i,i+2).join(' '),words.slice(i,i+3).join(' ')]);
  let degraded=false;
  const safe=async <T>(text:string,params:unknown[]=[])=>sql.query<T>(text,params).catch(()=>{degraded=true;return [] as T[];});
  const [brandRows,taxonomyRows,definitionRows]=await Promise.all([
    safe<{brand:string}>(`select p.brand from products p join merchants m on m.id=p.merchant_id
      where p.status='active' and m.status='active' and m.verified=true and p.brand is not null
        and (p.normalized_brand=any($1::text[]) or left(p.normalized_brand,3)=any($2::text[]))
      group by p.brand,p.normalized_brand order by case when p.normalized_brand=any($1::text[]) then 0 else 1 end,p.brand limit 256`,[phrases,words.map(w=>w.slice(0,3))]),
    safe<TaxonomyAlias>(`select alias,category,subcategory from marketplace_discovery_taxonomy_aliases a
      join category_taxonomy c on c.category_key=a.category and c.active=true
      where a.active=true and (a.subcategory is null or exists(select 1 from category_subcategories s where s.category_key=a.category and s.subcategory_key=a.subcategory and s.active=true))
      union all select category_key alias,category_key category,null subcategory from category_taxonomy where active=true
      order by alias limit 512`),
    safe<AttributeDefinition>(`select d.category,nullif(d.subcategory,'') subcategory,d.attribute_key as key,d.attribute_keys as keys,d.aliases,d.unit
      from marketplace_discovery_attribute_definitions d join category_taxonomy c on c.category_key=d.category and c.active=true
      where d.active=true and (d.subcategory='' or exists(select 1 from category_subcategories s where s.category_key=d.category and s.subcategory_key=d.subcategory and s.active=true))
      order by d.category,d.subcategory,d.attribute_key limit 128`),
  ]);
  const brands=brandRows.map(r=>r.brand);
  const corrected=correctDiscoveryQuery(classifyQueryIntent(query).normalized,{brands,categories:taxonomyRows.map(r=>r.alias)});
  const synonyms=await safe<Synonym>(`select term,synonym from marketplace_search_synonyms where status='active' and locale='en-GH'
    and (eide_normalize_synonym(term)=any($1::text[]) or eide_normalize_synonym(synonym)=any($1::text[])) order by term,synonym limit 48`,[meaningfulTokens(corrected).slice(0,12)]);
  const scope=taxonomyIntent(corrected,taxonomyRows);
  const cat=category??scope?.category,sub=subcategory??scope?.subcategory;
  const keys=definitionRows.filter(d=>d.category===cat&&(!d.subcategory||d.subcategory===sub)).flatMap(d=>d.keys);
  const rawWords=normalizeDiscoveryQuery(query).split(' ').slice(0,24);
  const attributePhrases=rawWords.flatMap((_,i)=>[rawWords[i],rawWords.slice(i,i+2).join(' '),rawWords.slice(i,i+3).join(' ')]);
  const candidates=[...new Set(attributePhrases.flatMap(value=>[normalizeAttributeValue(value,null),normalizeAttributeValue(value,'gb'),normalizeAttributeValue(value,'inch')]))];
  const attributeValues=cat&&keys.length?await safe<{key:string;value:string}>(`select distinct a.source_key as key,a.raw_value as value
    from marketplace_discovery_product_attributes a join products p on p.id=a.product_id join merchants m on m.id=p.merchant_id
    where p.status='active' and m.status='active' and m.verified=true and a.category=$1 and a.calculated_at>=now()-interval '6 hours'
      and ($2::text is null or a.subcategory=$2 or a.subcategory is null)
      and a.source_key=any($3::text[]) and a.normalized_value=any($4::text[])
    order by a.source_key,a.raw_value limit 128`,[cat,sub??null,keys,candidates]):[];
  return {brands,categories:taxonomyRows.map(r=>normalizeDiscoveryQuery(r.alias)),synonyms,taxonomy:taxonomyRows,definitions:definitionRows,attributeValues,degraded};
}
