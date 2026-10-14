import { getSql } from "@/lib/db";

/**
 * Object-level authorization helpers. Every sensitive object lookup must bind
 * the authenticated principal (or an explicitly verified merchant owner) in
 * the SQL predicate; IDs supplied by the browser are identifiers, never proof
 * of ownership.
 */
export async function requireCustomerOrder(orderId: string, userId: string) {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string; group_id: string; user_id: string; merchant_id: string; status: string;
    currency: string; product_total: string; delivery_total: string; grand_total: string;
    address: string; created_at: string;
  }>(
    `select id, group_id, user_id, merchant_id, status, currency,
            product_total::text, delivery_total::text, grand_total::text,
            address, created_at::text
       from orders
      where id = $1 and user_id = $2
      limit 1`,
    [orderId, userId],
  );
  if (!rows[0]) throw new Error("Order not found");
  return rows[0];
}

export async function requireMerchantOrder(orderId: string, merchantId: string) {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string; group_id: string; user_id: string; merchant_id: string; status: string;
    currency: string; product_total: string; delivery_total: string; grand_total: string;
    address: string; created_at: string;
  }>(
    `select id, group_id, user_id, merchant_id, status, currency,
            product_total::text, delivery_total::text, grand_total::text,
            address, created_at::text
       from orders
      where id = $1 and merchant_id = $2
      limit 1`,
    [orderId, merchantId],
  );
  if (!rows[0]) throw new Error("Order not found");
  return rows[0];
}

