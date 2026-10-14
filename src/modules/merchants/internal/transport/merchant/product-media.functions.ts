import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTransaction } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireMerchantWorkspaceForUserId, requireMerchantAccessForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const id = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/);
const scope = z.object({ merchantId: id, productId: id });
const uploadInput = scope.extend({
  uploadId: z.string().regex(/^upi_[a-f0-9]{32}$/),
  altText: z.string().trim().min(3).max(240),
  makePrimary: z.boolean().default(false),
});

async function authorize(merchantId: string, userId: string): Promise<void> {
  await requireMerchantWorkspaceForUserId(userId);
  await requireMerchantAccessForUserId(merchantId, userId);
  await requireFreshSession();
}

function mediaUrl(mediaId: string) {
  return `/api/product-media/${encodeURIComponent(mediaId)}`;
}

// Product row locks serialize image count and primary-picture changes across concurrent submissions.
export const attachMerchantProductImage = createServerFn({ method: "POST" })
  .middleware([authMiddleware]).validator(uploadInput)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await authorize(data.merchantId, userId);
    await enforceRateLimit("merchant-product-media-attach", { windowSeconds: 60, maxRequests: 20, subject: userId });
    return withTransaction(async (sql) => {
      const products = await sql.query<{ id: string; status:string }>(
        `select id,status from products where id=$1 and merchant_id=$2 and status not in ('archived','suspended')
           and catalog_source <> 'enterprise_api' for update`, [data.productId, data.merchantId]);
      if (!products[0]) throw new Error("Product is unavailable for manual image uploads");
      const intents = await sql.query<{object_key:string}>(
        `select object_key from storage_upload_intents
         where id=$1 and user_id=$2 and purpose='product-image' and resource_id=$3
           and status='verified' and consumed_at is null and verified_at>now()-interval '24 hours'
         for update`, [data.uploadId,userId,data.productId]);
      if (!intents[0]) throw new Error("Verified image upload is missing, already attached, or expired");
      const count = await sql.query<{count:number}>(
        `select count(*)::int as count from product_media where product_id=$1`, [data.productId]);
      const n = Number(count[0]?.count ?? 0);
      if (n >= 8) throw new Error("A product may have at most 8 images");
      const mediaId = `pmed_${randomUUID().replaceAll("-", "")}`;
      const primary = n === 0 || data.makePrimary;
      if (primary) await sql.query(`update product_media set is_primary=false where product_id=$1 and is_primary=true`, [data.productId]);
      await sql.query(`insert into product_media
        (id,product_id,media_type,storage_key,alt_text,sort_order,is_primary,upload_intent_id)
        values ($1,$2,'image',$3,$4,$5,$6,$7)`,
        [mediaId,data.productId,intents[0].object_key,data.altText,n,primary,data.uploadId]);
      await sql.query(`update storage_upload_intents set consumed_at=now() where id=$1 and consumed_at is null`, [data.uploadId]);
      await sql.query(`update products set image_path=case when $3 then $4 else image_path end,
        status=case when status='draft' then 'draft' else 'pending_review' end,
        updated_at=now() where id=$1 and merchant_id=$2`,
        [data.productId,data.merchantId,primary,mediaUrl(mediaId)]);
      await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        ["merchant.product.image.attached","product",data.productId,userId,"merchant",null,"success",JSON.stringify({mediaId,primary})]);
      return { mediaId, url: mediaUrl(mediaId), primary, status: products[0].status === "draft" ? "draft" as const : "pending_review" as const };
    });
  });

export const setMerchantProductPrimaryImage = createServerFn({ method:"POST" })
  .middleware([authMiddleware]).validator(scope.extend({mediaId:id}))
  .handler(async ({data,context}) => {
    const userId = getAuthenticatedUserId(context);
    await authorize(data.merchantId,userId);
    await enforceRateLimit("merchant-product-media-primary",{windowSeconds:60,maxRequests:30,subject:userId});
    return withTransaction(async sql => {
      const products = await sql.query<{id:string}>(`select id from products where id=$1 and merchant_id=$2
        and status not in ('archived','suspended') and catalog_source<>'enterprise_api' for update`,[data.productId,data.merchantId]);
      if (!products[0]) throw new Error("Product unavailable");
      const rows = await sql.query<{id:string}>(`select id from product_media where id=$1 and product_id=$2`,[data.mediaId,data.productId]);
      if (!rows[0]) throw new Error("Image does not belong to this product");
      await sql.query(`update product_media set is_primary=false where product_id=$1 and is_primary`,[data.productId]);
      await sql.query(`update product_media set is_primary=true where id=$1 and product_id=$2`,[data.mediaId,data.productId]);
      await sql.query(`update products set image_path=$3, status=case when status='draft' then 'draft' else 'pending_review' end,
         updated_at=now() where id=$1 and merchant_id=$2`,[data.productId,data.merchantId,mediaUrl(data.mediaId)]);
      await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        ["merchant.product.image.primary","product",data.productId,userId,"merchant",null,"success",JSON.stringify({mediaId:data.mediaId})]);
      return { primary: data.mediaId };
    });
  });

export const removeMerchantProductImage = createServerFn({ method:"POST" })
  .middleware([authMiddleware]).validator(scope.extend({mediaId:id}))
  .handler(async ({data,context}) => {
    const userId = getAuthenticatedUserId(context);
    await authorize(data.merchantId,userId);
    await enforceRateLimit("merchant-product-media-remove",{windowSeconds:60,maxRequests:30,subject:userId});
    return withTransaction(async sql => {
      const products=await sql.query<{id:string}>(`select id from products where id=$1 and merchant_id=$2
        and status not in ('archived','suspended') and catalog_source<>'enterprise_api' for update`,[data.productId,data.merchantId]);
      if (!products[0]) throw new Error("Product unavailable");
      const removed=await sql.query<{id:string;upload_intent_id:string|null;is_primary:boolean}>(
        `delete from product_media where id=$1 and product_id=$2 returning id,upload_intent_id,is_primary`,[data.mediaId,data.productId]);
      if (!removed[0]) throw new Error("Image does not belong to this product");
      // Reuse the durable cleanup worker; object deletion must not happen inside a DB transaction.
      if (removed[0].upload_intent_id) await sql.query(
        `update storage_upload_intents set status='cleanup_pending',cleanup_claim_token=null,
           cleanup_claim_expires_at=null,expires_at=now() where id=$1 and status='verified'`,
        [removed[0].upload_intent_id]);
      const next=await sql.query<{id:string}>(`select id from product_media where product_id=$1
        order by is_primary desc,sort_order,id limit 1`,[data.productId]);
      if (removed[0].is_primary || !next[0]) {
        if (next[0]) await sql.query(`update product_media set is_primary=true where id=$1`,[next[0].id]);
        await sql.query(`update products set image_path=$3,
          status=case when status='draft' then 'draft' else 'pending_review' end,updated_at=now()
          where id=$1 and merchant_id=$2`,
          [data.productId,data.merchantId,next[0]?mediaUrl(next[0].id):null]);
      } else await sql.query(`update products set status=case when status='draft' then 'draft' else 'pending_review' end,
        updated_at=now() where id=$1 and merchant_id=$2`,[data.productId,data.merchantId]);
      await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        ["merchant.product.image.removed","product",data.productId,userId,"merchant",null,"success",JSON.stringify({mediaId:data.mediaId})]);
      return { removed: data.mediaId, newPrimary: next[0]?.id ?? null };
    });
  });
