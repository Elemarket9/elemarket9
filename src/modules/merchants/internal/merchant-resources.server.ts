import { getSql } from "@/lib/db";
import { requireMerchantAccess, type AppRole } from "@/modules/identity/public/auth/authorization.server";

export async function requireMerchantProduct(productId: string, bearerToken?: string): Promise<{ userId: string; role: AppRole; merchantId: string; productId: string }> {
  const sql = await getSql();
  const rows = await sql.query<{ merchant_id: string; id: string }>(
    `select merchant_id, id from products where id = $1 limit 1`,
    [productId],
  );
  const product = rows[0];
  if (!product) throw new Error("Product not found");
  const principal = await requireMerchantAccess(product.merchant_id, bearerToken);
  return { ...principal, merchantId: product.merchant_id, productId: product.id };
}

export async function requireMerchantVariant(variantId: string, bearerToken?: string): Promise<{ userId: string; role: AppRole; merchantId: string; productId: string; variantId: string }> {
  const sql = await getSql();
  const rows = await sql.query<{ merchant_id: string; product_id: string; id: string }>(
    `select p.merchant_id, pv.product_id, pv.id
       from product_variants pv
       join products p on p.id = pv.product_id
      where pv.id = $1
      limit 1`,
    [variantId],
  );
  const variant = rows[0];
  if (!variant) throw new Error("Variant not found");
  const principal = await requireMerchantAccess(variant.merchant_id, bearerToken);
  return { ...principal, merchantId: variant.merchant_id, productId: variant.product_id, variantId: variant.id };
}

export async function requireMerchantMedia(mediaId: string, bearerToken?: string): Promise<{ userId: string; role: AppRole; merchantId: string; productId: string; mediaId: string }> {
  const sql = await getSql();
  const rows = await sql.query<{ merchant_id: string; product_id: string; id: string }>(
    `select p.merchant_id, pm.product_id, pm.id
       from product_media pm
       join products p on p.id = pm.product_id
      where pm.id = $1
      limit 1`,
    [mediaId],
  );
  const media = rows[0];
  if (!media) throw new Error("Product media not found");
  const principal = await requireMerchantAccess(media.merchant_id, bearerToken);
  return { ...principal, merchantId: media.merchant_id, productId: media.product_id, mediaId: media.id };
}

export async function requireMerchantProfile(merchantId: string, bearerToken?: string) {
  return requireMerchantAccess(merchantId, bearerToken);
}
