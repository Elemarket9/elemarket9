/** Replaceable Arkesel SMS-only transport (not Arkesel OTP generation/verification).
 * Docs: https://developers.arkesel.com/ /api/v2/sms/send */
export async function sendViaArkeselSms(phone:string,message:string):Promise<void>{
 const key=process.env.ARKESEL_API_KEY?.trim();
 if(!key)throw new Error("SMS provider credentials missing");
 const res=await fetch("https://sms.arkesel.com/api/v2/sms/send",{
  method:"POST",headers:{"api-key":key,"content-type":"application/json"},
  body:JSON.stringify({sender:process.env.ARKESEL_OTP_SENDER_ID?.trim()||"ELEMARKET",message,recipients:[phone.replace(/^\+/,"")]}),
  redirect:"error",signal:AbortSignal.timeout(10_000)
 });
 // Acceptance is not a telecom delivery receipt. Never log provider response.
 let data:unknown;
 try{data=await res.json()}catch{throw new Error("SMS transport returned an invalid response")}
 if(!res.ok || !data || typeof data!=="object" || (data as {status?:unknown}).status!=="success")throw new Error("SMS transport rejected handover message");
 const items=(data as {data?:unknown}).data;
 if(Array.isArray(items) && !items.some((item:unknown)=>item && typeof item==="object" && typeof (item as {id?:unknown}).id==="string"))
  throw new Error("SMS gateway accepted no recipient");
}
