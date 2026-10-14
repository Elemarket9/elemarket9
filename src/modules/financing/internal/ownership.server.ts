import { getSql } from "@/lib/db";
import type { JsonObject } from "@/lib/db-types";

export async function requireCustomerFinancingApplication(applicationId: string, userId: string) {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string; user_id: string; provider_id: string; order_group_id: string | null;
    amount: string; currency: string; status: string; provider_reference: string | null;
    redirect_url: string | null; expires_at: string | null; provider_decision_at: string | null; approved_amount: string | null; approved_initial_contribution: string | null; approved_currency: string | null; provider_terms: JsonObject;
  }>(
    `select id, user_id, provider_id, order_group_id, amount::text, currency,
            status, provider_reference, redirect_url, expires_at::text, provider_decision_at::text, approved_amount::text, approved_initial_contribution::text, approved_currency, provider_terms
       from customer_financing_applications
      where id = $1 and user_id = $2
      limit 1`,
    [applicationId, userId],
  );
  if (!rows[0]) throw new Error("Financing application not found");
  return rows[0];
}

export async function requireMerchantFinancingApplication(applicationId: string, merchantId: string) {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string; merchant_id: string; provider_id: string; requested_amount: string;
    currency: string; status: string; provider_reference: string | null;
    redirect_url: string | null; score_snapshot: number | null; score_model_version: string | null;
    expires_at: string | null;
  }>(
    `select id, merchant_id, provider_id, requested_amount::text, currency,
            status, provider_reference, redirect_url, score_snapshot, score_model_version,
            expires_at::text
       from merchant_financing_applications
      where id = $1 and merchant_id = $2
      limit 1`,
    [applicationId, merchantId],
  );
  if (!rows[0]) throw new Error("Financing application not found");
  return rows[0];
}
