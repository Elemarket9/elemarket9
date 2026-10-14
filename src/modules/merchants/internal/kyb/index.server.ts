import { getSql } from "@/lib/db";
import { getKybProvider } from "./registry.server";

export async function runMerchantKyb(applicationId: string): Promise<{ configured: boolean; decision?: string }> {
  const provider = getKybProvider();
  if (!provider) return { configured: false };

  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    business_name: string;
    registration_number: string | null;
    status: string;
    check_status: string;
  }>(
    `select ma.id, ma.business_name, ma.registration_number, ma.status, mvc.status as check_status
       from merchant_applications ma
       left join merchant_verification_checks mvc
         on mvc.application_id=ma.id and mvc.check_type='business'
      where ma.id=$1 limit 1`,
    [applicationId],
  );
  const app = rows[0];
  if (!app) throw new Error("Merchant application not found");

  const result = await provider.verifyBusiness({
    businessName: app.business_name,
    registrationNumber: app.registration_number ?? undefined,
    country: "GH",
  });
  const checkStatus = result.decision === "VERIFIED"
    ? "verified"
    : result.decision === "NOT_FOUND"
      ? "rejected"
      : "pending";

  await sql.query(
    `insert into merchant_verification_checks
       (id,application_id,check_type,status,provider_key,provider_reference,evidence_ref,reviewed_at,updated_at)
     values ($1,$2,'business',$3,$4,$5,$6,now(),now())
     on conflict(application_id,check_type) do update set
       status=excluded.status,
       provider_key=excluded.provider_key,
       provider_reference=excluded.provider_reference,
       evidence_ref=excluded.evidence_ref,
       reviewed_at=excluded.reviewed_at,
       updated_at=now()`,
    [
      `mvc_${crypto.randomUUID().replaceAll("-", "")}`,
      applicationId,
      checkStatus,
      result.provider,
      result.providerReference ?? null,
      JSON.stringify(result.evidence),
    ],
  );

  return { configured: true, decision: result.decision };
}
