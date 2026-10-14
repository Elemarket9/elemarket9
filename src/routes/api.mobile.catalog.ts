import {createFileRoute} from '@tanstack/react-router';
import {searchCatalogProducts} from '@/modules/catalog/public/catalog';
import {parseDiscoveryState} from '@/modules/catalog/public/discovery-state';
import {enforceRateLimit,rateLimitResponse} from '@/lib/security/rate-limit.server';
/** Native clients consume the same server ranking and signed continuation as the web. */
export const Route=createFileRoute('/api/mobile/catalog')({server:{handlers:{GET:async({request})=>{
 try{await enforceRateLimit('mobile-catalog',{windowSeconds:60,maxRequests:90});}catch(error){const limited=rateLimitResponse(error);if(limited)return limited;throw error;}
 const url=new URL(request.url);const raw=Object.fromEntries(url.searchParams);const requested=Number(raw.limit??30);
 if((raw.q?.length??0)>120||(raw.cursor?.length??0)>2048||!Number.isInteger(requested)||requested<1||requested>40)return Response.json({error:'Invalid discovery input.'},{status:400});
 try{
 const state=parseDiscoveryState(raw);
 if ((raw.lat != null)!==(raw.lon != null) || (raw.radiusKm != null && (raw.lat==null||raw.lon==null)) ||
     (raw.minPrice != null && state.minPrice==null) || (raw.maxPrice != null && state.maxPrice==null) ||
     (state.minPrice!=null&&state.maxPrice!=null&&state.minPrice>state.maxPrice) ||
     (raw.lat!=null&&state.lat==null) || (raw.lon!=null&&state.lon==null) ||
     (raw.radiusKm!=null&&state.radiusKm==null) ||
     (raw.category!=null&&state.category==null) || (raw.condition!=null&&state.condition==null) ||
     (raw.listingType!=null&&state.listingType==null) || (raw.merchantId!=null&&state.merchantId==null) ||
     (raw.sort!=null&&!['relevance','newest','price_asc','price_desc'].includes(String(raw.sort)))) {
   return Response.json({error:'Invalid discovery filters.'},{status:400,headers:{'cache-control':'no-store'}});
 }
 const page=await searchCatalogProducts({data:{...state,limit:requested,cursor:raw.cursor}});
 return Response.json({...page,products:page.products.map(p=>({id:p.id,merchant_id:p.merchantId,merchant_name:p.merchantName,name:p.name,category:p.category,price:p.price,stock:p.stock,image_path:p.imagePath,city:p.city,description:p.description,has_variants:p.hasVariants,attribution_receipt:p.attributionReceipt}))},{headers:{'cache-control':'no-store'}});
 }catch(error){
 const message=error instanceof Error?error.message:'';
 if (message.startsWith('Search catalog changed')||message.startsWith('Search ranking refreshed'))return Response.json({error:'Search results changed; restart pagination.'},{status:409,headers:{'cache-control':'no-store'}});
 if (message.startsWith('invalid ')||message.startsWith('search cursor does not match')||(error instanceof Error&&error.name==='ZodError'))return Response.json({error:'Invalid discovery filters or cursor.'},{status:400,headers:{'cache-control':'no-store'}});
 return Response.json({error:'Discovery is temporarily unavailable. Please restart or retry your search.'},{status:503,headers:{'cache-control':'no-store'}});
}
}}}});
