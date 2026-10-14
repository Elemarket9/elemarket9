import { getSql } from "@/lib/db";

export async function requireCustomerPayment(paymentId: string, userId: string) {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string; order_id: string; user_id: string; amount: string; currency: string;
    method: string; status: string; provider_key: string | null;
  }>(
    `select p.id, p.order_id, p.user_id, p.amount::text, p.currency,
            p.method, p.status, p.provider_key
       from payments p
       join orders o on o.id = p.order_id
      where p.id = $1 and p.user_id = $2 and o.user_id = $2
      limit 1
      for update`,
    [paymentId, userId],
  );
  if (!rows[0]) throw new Error("Payment not found");
  return rows[0];
}

