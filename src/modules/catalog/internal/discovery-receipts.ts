type StoredExposure={productId:string;receipt:string;receivedAt:number};
const key='elemarket:discovery-receipts:v1';let memory:StoredExposure[]=[];
function valid(row:StoredExposure,now:number){return typeof row?.productId==='string'&&row.productId.length<=128&&typeof row.receipt==='string'&&row.receipt.length<=1024&&Number.isFinite(row.receivedAt)&&row.receivedAt<=now&&now-row.receivedAt<900000;}
function read(now:number){try{const value:unknown=JSON.parse(sessionStorage.getItem(key)??'[]');if(Array.isArray(value))memory=value.filter(row=>valid(row,now)).slice(-40);}catch{/* Opaque memory cache preserves navigation when storage is unavailable. */}return memory.filter(row=>valid(row,now));}
/** Ephemeral opaque receipts; never put them in durable URLs or trust their payload client-side. */
export function rememberDiscoveryReceipt(productId:string,receipt:string|undefined,now=Date.now()){
 if(!receipt||receipt.length>1024||productId.length>128||!Number.isFinite(now))return;
 memory=[...read(now).filter(row=>row.productId!==productId),{productId,receipt,receivedAt:now}].slice(-40);
 try{sessionStorage.setItem(key,JSON.stringify(memory));}catch{/* Opaque memory cache preserves navigation when storage is unavailable. */}
}
export function recallDiscoveryReceipt(productId:string,now=Date.now()){return read(now).find(row=>row.productId===productId)?.receipt;}
