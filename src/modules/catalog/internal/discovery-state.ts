import {CATEGORY_KEYS} from '@/modules/shared/public/categories';
export type DiscoverySort='relevance'|'newest'|'price_asc'|'price_desc';
export type DiscoveryState={q?:string;category?:typeof CATEGORY_KEYS[number];subcategory?:string;brand?:string;condition?:'new'|'refurbished'|'used'|'open_box';minPrice?:number;maxPrice?:number;lat?:number;lon?:number;radiusKm?:number;sort?:DiscoverySort;merchantId?:string;listingType?:'product'|'food'|'stay'};
const text=(value:unknown,max:number)=>typeof value==='string'?value.trim().slice(0,max)||undefined:undefined;
const price=(value:unknown)=>{if(typeof value!=='string'&&typeof value!=='number'||value==='')return undefined;const n=Number(value);return Number.isFinite(n)&&n>=0&&n<=9999999999.99?n:undefined;};
const coordinate=(value:unknown,min:number,max:number)=>{if(value==null||value==='')return undefined;const n=Number(value);return Number.isFinite(n)&&n>=min&&n<=max?n:undefined;};
/** Durable explicit customer input only. Interpretation and cursors never live here. */
export function parseDiscoveryState(raw:Record<string,unknown>):DiscoveryState {
 const category=text(raw.category,64);const condition=text(raw.condition,16);const sort=text(raw.sort,16);const listingType=text(raw.listingType,16);
 return {q:text(raw.q,120),category:CATEGORY_KEYS.includes(category as typeof CATEGORY_KEYS[number])?category as typeof CATEGORY_KEYS[number]:undefined,
  subcategory:text(raw.subcategory,64),brand:text(raw.brand,120),condition:['new','refurbished','used','open_box'].includes(condition??'')?condition as DiscoveryState['condition']:undefined,
  minPrice:price(raw.minPrice),maxPrice:price(raw.maxPrice),lat:coordinate(raw.lat,-90,90),lon:coordinate(raw.lon,-180,180),radiusKm:coordinate(raw.radiusKm,3,100),sort:['newest','price_asc','price_desc'].includes(sort??'')?sort as DiscoverySort:undefined,merchantId:text(raw.merchantId,64),listingType:['product','food','stay'].includes(listingType??'')?listingType as DiscoveryState['listingType']:undefined};
}
export function discoveryIdentity(state:DiscoveryState){return JSON.stringify(parseDiscoveryState(state));}
export function hasDiscoveryFilters(state:DiscoveryState){return Object.values(parseDiscoveryState(state)).some(v=>v!==undefined);}
export function discoveryUrl(raw:Record<string,unknown>){const params=new URLSearchParams();for(const [k,v] of Object.entries(parseDiscoveryState(raw)))if(v!==undefined)params.set(k,String(v));return '/'+(params.size?'?'+params:'');}
export function priceRange(min:string,max:string):{minPrice?:number;maxPrice?:number;error?:string}{
 const lower=price(min.trim()),upper=price(max.trim());
 if(min.trim()&&lower==null||max.trim()&&upper==null)return {error:'Enter a valid non-negative price.'};
 if(lower!=null&&upper!=null&&lower>upper)return {error:'Minimum price must not exceed maximum price.'};
 return {minPrice:lower,maxPrice:upper};
}
/** Preserve server ordering while removing accidental repeated cards. No client reranking. */
export function appendDiscoveryPage<T extends {id:string}>(current:readonly T[],page:readonly T[]):T[]{const seen=new Set<string>();return [...current,...page].filter(p=>{if(seen.has(p.id))return false;seen.add(p.id);return true;});}
/** Keep the customer's validated choice visible when a zero-result facet is empty. */
export function discoveryFacetOptions(rows:readonly {value:string;count:number}[],selected?:string){return selected&&!rows.some(row=>row.value===selected)?[...rows,{value:selected,count:0}]:rows;}
