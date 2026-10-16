import {createFileRoute} from "@tanstack/react-router";
import {authorizeScheduledJobRequest} from "@/lib/security/internal-job-auth.server";
import {dispatchRiderInvitationOutbox} from "@/modules/logistics/public/transport/rider-invitation-outbox.server";
export const Route=createFileRoute("/api/internal/rider-invitations")({server:{handlers:{
 GET:async({request})=>{
  if(!(await authorizeScheduledJobRequest(request,process.env.CRON_SECRET)))
   return new Response("Unauthorized",{status:401});
  try{return Response.json(await dispatchRiderInvitationOutbox(20),{headers:{"cache-control":"no-store"}})}
  catch{return new Response("Invitation dispatch failed",{status:503})}
 }
}}});
