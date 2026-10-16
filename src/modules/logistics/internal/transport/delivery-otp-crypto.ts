import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
/** This secret MUST be independent from sessions/passwords. 32+ random bytes, hex. */
function macKey(): Buffer {
 const raw=process.env.ELEMARKET_HANDOVER_OTP_HMAC_KEY??"";
 if(!/^[0-9a-f]{64,}$/i.test(raw) || raw.length%2!==0) throw new Error("Handover OTP signing key missing or invalid (64+ hex digits required)");
 return Buffer.from(raw,"hex");
}
export function generateHandoverCode():string {return randomInt(0,1_000_000).toString().padStart(6,"0");}
export function handoverMac(challengeId:string,jobId:string,orderId:string,riderId:string,phone:string,code:string):string {
 return createHmac("sha256",macKey()).update(JSON.stringify(["delivery_handover/v1",challengeId,jobId,orderId,riderId,phone,code])).digest("hex");
}
export function verifyHandoverMac(expected:string,actual:string):boolean {
 if(!/^[0-9a-f]{64}$/.test(expected)|| !/^[0-9a-f]{64}$/.test(actual))return false;
 return timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(actual,"hex"));
}
