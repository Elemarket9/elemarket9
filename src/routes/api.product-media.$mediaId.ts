import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { getStorageProvider } from "@/lib/storage/registry.server";
import { auth } from "@/modules/identity/public/auth/server";
import { enforceRateLimit, rateLimitResponse } from "@/lib/security/rate-limit.server";

const noStore = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

// Stable, provider-neutral product URL. Never return raw private object keys to the browser.
// Only published products are public; merchants can preview their own pending media.
export const Route = createFileRoute("/api/product-media/$mediaId")({
  server: { handlers: { GET: async ({request,params}) => {
    const mediaId=String(params.mediaId??"");
    if (!/^pmed_[a-f0-9]{32}$/.test(mediaId)) return new Response("Not found",{status:404,headers:noStore});
    try { await enforceRateLimit("product-media-get",{windowSeconds:60,maxRequests:180}); }
    catch(error) { const limited=rateLimitResponse(error); if(limited) return limited; throw error; }
    const sql=await getSql();
    const rows=await sql.query<{storage_key:string;product_id:string;merchant_id:string;public:boolean}>(
      `select pm.storage_key, p.id product_id,p.merchant_id,
        (p.status='active' and m.status='active' and m.verified=true) as public
        from product_media pm join products p on p.id=pm.product_id
        join merchants m on m.id=p.merchant_id
       where pm.id=$1 and pm.media_type='image' limit 1`,[mediaId]);
    const row=rows[0];
    if(!row) return new Response("Not found",{status:404,headers:noStore});
    if (!row.public) {
      const session=await auth.api.getSession({headers:request.headers});
      if(!session?.user) return new Response("Not found",{status:404,headers:noStore});
      const authorized=await sql.query<{id:string}>(
        `select ma.user_id as id from merchant_accounts ma where ma.merchant_id=$1 and ma.user_id=$2
         and ma.status='active' limit 1`,[row.merchant_id,session.user.id]);
      if(!authorized[0]) return new Response("Not found",{status:404,headers:noStore});
    }
    // Redirect uses a short-lived signature; storage credentials stay on the server.
    const target=await getStorageProvider().createPresignedDownload({key:row.storage_key,expiresInSeconds:120});
    return new Response(null,{status:302,headers:{...noStore,location:target.downloadUrl}});
  } } },
});
