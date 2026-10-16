/** ELEMARKET owns the OTP; this contract transports only a text message.
 * Provider-specific HTTP protocol belongs in the adapter, never the handover domain. */
import { sendViaArkeselSms } from "../../adapters/providers/arkesel-sms.server";
import { getElemarketEnvironment } from "@/lib/env.server";
export interface DeliverySmsTransport {send(phone:string,message:string):Promise<void>}
export function getDeliverySmsTransport():DeliverySmsTransport {
 const key=(process.env.ELEMARKET_HANDOVER_SMS_PROVIDER??"").trim().toLowerCase();
 if(key==="arkesel")return {send:sendViaArkeselSms};
 if(key==='controlled-local'){
  const db=new URL(process.env.DATABASE_URL??'');
  const target=new URL(process.env.ELEMARKET_TEST_SMS_ENDPOINT??'');
  const token=process.env.ELEMARKET_TEST_TRANSPORT_TOKEN??'';
  if(getElemarketEnvironment()!=='development' || process.env.ELEMARKET_ENABLE_TEST_TRANSPORT!=='isolated-local-only'
   || !db.pathname.startsWith('/elemarket_test_') || !['127.0.0.1','localhost'].includes(db.hostname)
   || target.protocol!=='http:' || target.hostname!=='127.0.0.1' || target.username || target.password || token.length<32)
   throw new Error('Controlled transport is restricted to isolated local development');
  return {send:async(phone,message)=>{
   const response=await fetch(target,{method:'POST',headers:{'content-type':'application/json','x-test-transport-token':token},body:JSON.stringify({phone,message}),redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw new Error('Controlled transport refused message');
  }};
 }
 throw new Error("No approved delivery SMS transport is configured");
}
