import { getSql } from "@/lib/db";

export type RiskDecision = "allow" | "review" | "block";

export type RiskAssessment = {
  decision: RiskDecision;
  score: number;
  reasons: string[];
  assessmentId: string;
};

/**
 * ELEMARKET-owned, provider-neutral risk layer. It never moves money and does
 * not replace payment-provider fraud tooling. It produces an auditable decision
 * that the commerce/payment flows can enforce.
 */
export async function assessCheckoutRisk(input: {
  userId: string;
  fingerprint: string;
  productTotal: number;
  grandTotal: number;
}): Promise<RiskAssessment> {
  const sql = await getSql();
  const rows = await sql.query<{
    result: RiskAssessment;
  }>(
    `select evaluate_checkout_risk($1,$2,$3,$4) as result`,
    [input.userId, input.fingerprint, input.productTotal, input.grandTotal],
  );
  if (!rows[0]?.result) throw new Error("Risk assessment failed");
  return rows[0].result;
}
