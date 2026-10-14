import { createHash } from "node:crypto";
import { classifyQueryIntent, correctDiscoveryQuery, meaningfulTokens, normalizeDiscoveryQuery } from "./intelligence";

export type Synonym = { term: string; synonym: string };
export type TaxonomyAlias = { alias: string; category: string; subcategory: string | null };
export type AttributeDefinition = { category: string; subcategory: string | null; key: string; keys: string[]; aliases: string[]; unit: string | null };
export type AttributeTerm = { key: string; keys: string[]; value: string; phrase: string; hard: boolean; unit: string | null };
export type DiscoveryMetadata = { brands: string[]; categories: string[]; synonyms: Synonym[]; taxonomy: TaxonomyAlias[]; definitions: AttributeDefinition[]; attributeValues: { key: string; value: string }[]; degraded: boolean };
export type QueryPlan = ReturnType<typeof buildQueryPlan>;

const normalized = normalizeDiscoveryQuery;
export function normalizeAttributeValue(value: string, unit: string | null): string {
  const raw = value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g," ");
  if (unit === "gb") {
    const match=raw.match(/^(\d+(?:\.\d+)?)\s*(gb|tb)?$/);
    if(match) return `${Number(match[1])*(match[2]==="tb"?1024:1)}gb`;
  }
  if (unit === "inch") {
    const match=raw.match(/^(\d+(?:\.\d+)?)\s*(?:inch|inches|in|")?$/);
    if(match)return `${Number(match[1])}inch`;
  }
  return raw.replace(/\s+/g,"");
}
function phrasePresent(text: string, phrase: string) { return (` ${text} `).includes(` ${phrase} `); }
export function taxonomyIntent(query: string, aliases: TaxonomyAlias[]): TaxonomyAlias | undefined {
  const matches=aliases.filter(a=>a.alias.length>0&&phrasePresent(query,normalized(a.alias)))
    .sort((a,b)=>b.alias.length-a.alias.length||a.alias.localeCompare(b.alias));
  if(!matches.length)return undefined;
  const longest=matches[0].alias.length;
  const strongest=matches.filter(a=>a.alias.length===longest);
  const targets=new Set(strongest.map(a=>`${a.category}:${a.subcategory??""}`));
  return targets.size===1?strongest[0]:undefined;
}
/** One-hop token groups; no Cartesian query expansion and no recursive graph walk. */
export function synonymGroups(query: string, rows: Synonym[], identifier?: string): string[][] {
  const tokens=meaningfulTokens(query).slice(0,12);
  if(identifier)return tokens.map(t=>[t]);
  let extra=0;
  return tokens.map(token=>{
    const synonyms=rows.flatMap(row=>{
      const term=normalized(row.term), synonym=normalized(row.synonym);
      return term===token?[synonym]:synonym===token?[term]:[];
    }).filter(t=>t&&t!==token&&t.length<=60&&meaningfulTokens(t).length<=4);
    const unique=[...new Set(synonyms)].sort().slice(0,Math.min(3,24-extra));
    extra+=unique.length;
    return [token,...unique];
  });
}
export function buildQueryPlan(raw: string, metadata: DiscoveryMetadata, explicitSort="relevance", explicitCategory?: string, explicitSubcategory?: string, identifier?: string) {
  const initial=classifyQueryIntent(raw);
  const corrected=identifier?initial.normalized:correctDiscoveryQuery(initial.normalized,{brands:metadata.brands,categories:metadata.categories});
  const validated=classifyQueryIntent(corrected,{brands:metadata.brands,categories:metadata.categories});
  const intent={...initial,brandHint:validated.brandHint,categoryHints:validated.categoryHints};
  const taxonomy=taxonomyIntent(corrected,metadata.taxonomy);
  const category=explicitCategory??taxonomy?.category;
  const subcategory=explicitSubcategory??(category===taxonomy?.category?taxonomy?.subcategory:undefined);
  let lexical=corrected;
  const attributes: AttributeTerm[]=[];
  const attributeText=lexical;
  // Catalog-observed values are matched with their category-owned keys/units.
  // Plain mentions are preferences; only explicit "must have" requests are hard.
  for(const definition of metadata.definitions.filter(d=>d.category===category&&(!d.subcategory||d.subcategory===subcategory))) {
    const values=metadata.attributeValues.filter(v=>definition.keys.includes(v.key));
    for(const entry of values) {
      if(attributes.length>=4||attributes.some(a=>a.key===definition.key))break;
      const canonical=normalizeAttributeValue(entry.value,definition.unit);
      const phrases=new Set([...(definition.unit && /^\d+(?:\.\d+)?$/.test(entry.value)?[]:[normalized(entry.value)]),normalized(canonical),...definition.aliases.flatMap(alias=>[`${normalized(entry.value)} ${normalized(alias)}`,`${normalized(alias)} ${normalized(entry.value)}`,`${normalized(canonical)} ${normalized(alias)}`,`${normalized(alias)} ${normalized(canonical)}`])]);
      if(definition.unit==="inch") {const number=canonical.replace(/inch$/," ").trim();phrases.add(`${number} inch`);phrases.add(`${number} inches`);}
      if(definition.unit==="gb") {const number=canonical.replace(/gb$/," ").trim();phrases.add(`${number} gb`);}
      const present=[...phrases].filter(p=>p&&phrasePresent(attributeText,p)).sort((a,b)=>b.length-a.length||a.localeCompare(b));
      if(!present.length)continue;
      const phrase=present[0];
      // An unqualified value shared by multiple keys (e.g. RAM/storage) remains lexical.
      const conflicts=metadata.definitions.filter(d=>d.category===category&&(!d.subcategory||d.subcategory===subcategory)&&d.key!==definition.key)
        .some(d=>metadata.attributeValues.some(v=>d.keys.includes(v.key)&&normalizeAttributeValue(v.value,d.unit)===canonical));
      const qualified=definition.aliases.some(a=>phrasePresent(phrase,normalized(a)));
      if(conflicts&&!qualified)continue;
      const hard=phrasePresent(attributeText,`must have ${phrase}`);
      lexical=(` ${lexical} `).replace(` ${hard?`must have ${phrase}`:phrase} `," ").trim();
      attributes.push({key:definition.key,keys:[...definition.keys].sort(),value:canonical,phrase,hard,unit:definition.unit});
    }
  }
  const cheapest=/\bcheapest\b/u.test(raw.toLowerCase());
  const newest=intent.wantsNewest;
  lexical=lexical.replace(/\b(?:cheapest|cheap|budget|affordable|best value|best|value|deals?)\b/gu," ");
  if(taxonomy&&(newest||cheapest))lexical=(` ${lexical} `).replace(` ${normalized(taxonomy.alias)} `," ").trim();
  lexical=normalized(lexical);
  const groups=synonymGroups(lexical,metadata.synonyms,identifier);
  const effectiveSort=explicitSort!=="relevance"?explicitSort:newest?"newest":cheapest?"price_asc":"relevance";
  const interpretation={lexical,identifier:identifier??null,groups,category:category??null,subcategory:subcategory??null,attributes,
    hardFloor:intent.hardPriceFloor??null,hardCeiling:intent.hardPriceCeiling??null,softBudget:intent.hardPriceCeiling==null?intent.priceCeiling??null:null,
    brand:intent.brandHint??null,availability:intent.wantsAvailability,effectiveSort,valueSeeking:intent.valueSeeking,degraded:metadata.degraded};
  return {...interpretation,intent,hash:createHash("sha256").update(JSON.stringify(interpretation)).digest("hex")};
}
