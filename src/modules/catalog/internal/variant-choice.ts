import type {ProductVariant} from '@/modules/shared/public/types';
/** Choose a real in-stock SKU, never manufacture an attribute combination. */
export function chooseProductVariant(variants:readonly ProductVariant[],selected:ProductVariant|null,key:string,value:string):ProductVariant|undefined{
 const matches=(variant:ProductVariant)=>Object.entries(selected?.attributes??{}).filter(([k,v])=>k!==key&&String(variant.attributes[k]??'')===String(v)).length;
 return variants.filter(v=>v.status==='active'&&v.stock>0&&String(v.attributes[key]??'')===value)
 .sort((a,b)=>matches(b)-matches(a)||a.id.localeCompare(b.id))[0];
}
