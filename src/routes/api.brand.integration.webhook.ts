import { createFileRoute } from "@tanstack/react-router";
import { enqueueBrandIntegrationWebhook, verifyStoredBrandWebhook } from "@/modules/merchants/public/brand-integration.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { readBodyWithLimit } from "@/lib/security/body.server";

export const Route = createFileRoute("/api/brand/integration/webhook")({
  server:{handlers:{POST:async({request})=>{
    const connectionId=new URL(request.url).searchParams.get("connectionId")?.trim();
    if(!connectionId) return new Response("Missing connectionId",{status:400});
    await enforceRateLimit("brand-integration-webhook-global",{windowSeconds:60,maxRequests:300});
    let rawBody:string;
    try{rawBody=await readBodyWithLimit(request,2*1024*1024);}catch{return new Response("Payload too large",{status:413});}
    const signature=request.headers.get("x-elemarket-signature")??request.headers.get("x-signature");
    const timestamp=request.headers.get("x-elemarket-timestamp");
    if(!(await verifyStoredBrandWebhook(connectionId,rawBody,signature,timestamp))) return new Response("Invalid integration signature",{status:401});
    await enforceRateLimit(`brand-integration-webhook:${connectionId}`,{windowSeconds:60,maxRequests:60});
    let payload:unknown;
    try{payload=JSON.parse(rawBody);}catch{return new Response("Invalid JSON",{status:400});}
    if(!payload||typeof payload!=="object"||Array.isArray(payload)) return new Response("Invalid webhook payload",{status:400});
    const record=payload as Record<string,unknown>;
    const eventId=(request.headers.get("x-event-id")?.trim()||(typeof record.eventId==="string"?record.eventId.trim():null))?.slice(0,200)??null;
    const eventType=(request.headers.get("x-event-type")?.trim()||(typeof record.eventType==="string"?record.eventType.trim():"catalog.changed"))?.slice(0,80)??"catalog.changed";
    const result=await enqueueBrandIntegrationWebhook({connectionId,externalEventId:eventId,eventType,rawBody,payload});
    return Response.json({ok:true,result},{status:result.duplicate?200:202});
  }}}
});
