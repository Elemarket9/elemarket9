import {EIDE_VERSION} from './version';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
/** Signed exposure identity. No raw query, customer ID, IP or device identifier.
 * Observation data never controls payment/order state and is not trusted commerce.
 */
export type DiscoveryExposure={v:typeof EIDE_VERSION|'eide-v11';request:string;queryHash:string;productId:string;position:number;exp:number};
export type DiscoveryEventType='impression'|'click'|'view'|'add_to_cart'|'wishlist'|'checkout'|'purchase'|'delivered'|'cancelled'|'returned'|'refunded'|'disputed';
export function exposureRequest(){return randomUUID();}
export function signExposure(exposure:DiscoveryExposure,secret:string){
  if(secret.length<16)throw new Error('Exposure signing secret too short');
  const body=Buffer.from(JSON.stringify(exposure)).toString('base64url');
  return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
}
export function verifyExposure(receipt:string,secret:string,now=Date.now()/1000):DiscoveryExposure|null{
  if(secret.length<16||receipt.length>1024||!Number.isFinite(now))return null;
  const [body,sig,...extra]=receipt.split('.');if(extra.length||!body||!sig)return null;
  const expected=createHmac('sha256',secret).update(body).digest('base64url');
  if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
  try{
    const value=JSON.parse(Buffer.from(body,'base64url').toString()) as DiscoveryExposure;
    if(!['eide-v11',EIDE_VERSION].includes(value.v)||typeof value.request!=='string'||!/^[-a-f0-9]{36}$/.test(value.request)||typeof value.queryHash!=='string'||!/^[-a-f0-9]{64}$/.test(value.queryHash)
      ||typeof value.productId!=='string'||!value.productId||value.productId.length>128||!Number.isSafeInteger(value.position)||value.position<1||value.position>1000
      ||!Number.isSafeInteger(value.exp)||value.exp<=now||value.exp>now+900)return null;
    return value;
  }catch{return null;}
}
export type AttributedObservation={exposure:DiscoveryExposure;eventType:DiscoveryEventType;observedAt:number;source:'client'|'authoritative-commerce'};
export function learningObservation(exposure:DiscoveryExposure,eventType:DiscoveryEventType,observedAt:number,source:AttributedObservation['source']):AttributedObservation|null{
  const commerce=['purchase','delivered','cancelled','returned','refunded','disputed'].includes(eventType);
  if(!Number.isFinite(observedAt)||observedAt<0||commerce&&source!=='authoritative-commerce')return null;
  return {exposure,eventType,observedAt,source};
}
