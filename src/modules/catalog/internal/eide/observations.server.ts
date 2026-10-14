import {createHash} from 'node:crypto';
import {getDiscoverySql} from '@/lib/db';
import {env} from '@/lib/env.server';
import {verifyExposure} from './attribution.server';
export async function recordDiscoveryObservation(receipt:string,eventType:'impression'|'click'|'view'|'add_to_cart'|'wishlist'|'checkout') {
  if(!['impression','click','view','add_to_cart','wishlist','checkout'].includes(eventType))return false;
  const signing=env('SEARCH_CURSOR_SECRET')||env('BETTER_AUTH_SECRET')||(process.env.NODE_ENV==='production'?'':'development-search-cursor-secret-change-me');
  if(!signing)return false;
  const exposure=verifyExposure(receipt,createHash('sha256').update(signing).digest('hex'));
  if(!exposure)return false;
  try {
    const sql=await getDiscoverySql();
    const key=createHash('sha256').update(`${exposure.request}:${exposure.productId}:${eventType}`).digest('hex');
    await sql.query(`insert into eide_ranking_events(event_type,product_id,query_hash,position,model_version,exposure_event_key)
      select $1,p.id,$3,$4,$5,$6 from products p join merchants m on m.id=p.merchant_id
      where p.id=$2 and p.status='active' and m.status='active' and m.verified=true
      on conflict(exposure_event_key) where exposure_event_key is not null do nothing`,[eventType,exposure.productId,exposure.queryHash,exposure.position,exposure.v,key]);
    return true;
  }catch{return false;}
}

/** Optional post-checkout attribution. Reads authoritative ownership/items; never writes commerce. */
export async function linkDiscoveryOrder(userId:string,orderId:string,receipt:string):Promise<boolean>{
 const signing=env('SEARCH_CURSOR_SECRET')||env('BETTER_AUTH_SECRET')||(process.env.NODE_ENV==='production'?'':'development-search-cursor-secret-change-me');
 if(!signing||!userId||!orderId||orderId.length>128)return false;
 const exposure=verifyExposure(receipt,createHash('sha256').update(signing).digest('hex'));if(!exposure)return false;
 try{const sql=await getDiscoverySql();const rows=await sql.query<{order_id:string}>(`insert into eide_attributed_orders(order_id,product_id,exposure_request,query_hash,position,model_version)
 select o.id,$3,$4,$5,$6,$7 from orders o where o.id=$1 and o.user_id=$2
 and exists(select 1 from order_items i where i.order_id=o.id and i.product_id=$3)
 and not exists(select 1 from merchant_accounts ma where ma.merchant_id=o.merchant_id and ma.user_id=o.user_id)
 on conflict(order_id,product_id) do nothing returning order_id`,[orderId,userId,exposure.productId,exposure.request,exposure.queryHash,exposure.position,exposure.v]);
 return rows.length>0;
 }catch{return false;}
}
