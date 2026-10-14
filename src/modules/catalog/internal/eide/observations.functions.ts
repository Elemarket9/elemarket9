import {createServerFn} from '@tanstack/react-start';
import {z} from 'zod';
import {enforceRateLimit} from '@/lib/security/rate-limit.server';
import {authMiddleware,getAuthenticatedUserId} from '@/modules/identity/public/auth/middleware';
import {recordDiscoveryObservation,linkDiscoveryOrder} from './observations.server';
export const recordSearchObservation=createServerFn({method:'POST'})
  .validator(z.object({receipt:z.string().max(1024),eventType:z.enum(['impression','click','view','add_to_cart','wishlist','checkout'])}))
  .handler(async({data})=>{
    try{await enforceRateLimit('discovery-observation',{windowSeconds:60,maxRequests:180});return {recorded:await recordDiscoveryObservation(data.receipt,data.eventType)};}
    catch{return {recorded:false};}
  });

export const linkSearchOrders=createServerFn({method:'POST'})
 .middleware([authMiddleware])
 .validator(z.object({links:z.array(z.object({orderId:z.string().min(1).max(128),receipt:z.string().max(1024)})).max(40)}))
 .handler(async({data,context})=>{
  try{const userId=getAuthenticatedUserId(context);await enforceRateLimit('discovery-order-link',{windowSeconds:60,maxRequests:12,subject:userId});
   let linked=0;for(const link of data.links)if(await linkDiscoveryOrder(userId,link.orderId,link.receipt))linked++;
   return {linked};
  }catch{return {linked:0};}
 });
