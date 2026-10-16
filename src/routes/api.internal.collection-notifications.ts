import {createFileRoute} from "@tanstack/react-router";
import {authorizeScheduledJobRequest} from "@/lib/security/internal-job-auth.server";
import {dispatchCollectionNotifications} from "@/modules/logistics/public/transport/collection-notifications.server";
export const Route=createFileRoute('/api/internal/collection-notifications')({server:{handlers:{GET:async({request})=>{
 if(!await authorizeScheduledJobRequest(request,process.env.CRON_SECRET))return new Response('Unauthorized',{status:401});
 try{return Response.json(await dispatchCollectionNotifications(),{headers:{'cache-control':'no-store'}})}catch{return new Response('Collection notifications unavailable',{status:503})}
}}}});
