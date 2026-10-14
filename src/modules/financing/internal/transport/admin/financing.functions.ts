import type { JsonObject } from "@/lib/db-types";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { getSql, withTransaction } from "@/lib/db";

const providerSchema = z.object({
  id: z.string().trim().min(1).max(128),
  providerKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,127}$/),
  name: z.string().trim().min(2).max(160),
  providerLegalName: z.string().trim().min(2).max(200),
  audience: z.enum(["customer","merchant"]),
  productType: z.enum(["bnpl","installment","merchant_cash_advance","line_of_credit","term_loan"]),
  status: z.enum(["active","inactive","review"]),
  marketplaceEnabled: z.boolean(),
  marketplacePartnerStatus: z.enum(["review","active","suspended","terminated"]),
  securityReviewStatus: z.enum(["pending","passed","failed","waived"]),
  integrationStatus: z.enum(["pending","testing","ready","degraded","disabled"]),
  commercialStatus: z.enum(["pending","active","paused","ended"]),
  customerChannelEnabled: z.boolean(),
  providerSuppliedReference: z.string().trim().max(300).optional(),
  integrationMode: z.enum(["api","partner_handoff","manual_review"]),
  applicationUrl: z.string().url().max(2000).optional(),
  termsUrl: z.string().url().max(2000),
  privacyUrl: z.string().url().max(2000),
  minimumApplicationAmount: z.number().positive().max(100_000_000).optional(),
  maximumApplicationAmount: z.number().positive().max(100_000_000).optional(),
  reason: z.string().trim().min(12).max(1000),
});

export const loadFinancingProvidersAdmin = createServerFn({method:"GET"}).middleware([authMiddleware]).handler(async({context})=>{
  const userId=getAuthenticatedUserId(context); await requireAdminForUserId(userId, "admin.financing.manage"); const sql=await getSql();
  return sql.query<JsonObject>(`select id,provider_key as "providerKey",name,provider_legal_name as "providerLegalName",audience,product_type as "productType",status,
    marketplace_enabled as "marketplaceEnabled",marketplace_partner_status as "marketplacePartnerStatus",security_review_status as "securityReviewStatus",
    integration_status as "integrationStatus",commercial_status as "commercialStatus",customer_channel_enabled as "customerChannelEnabled",
    provider_supplied_reference as "providerSuppliedReference",integration_mode as "integrationMode",application_url as "applicationUrl",
    terms_url as "termsUrl",privacy_url as "privacyUrl",minimum_application_amount::float8 as "minimumApplicationAmount",
    maximum_application_amount::float8 as "maximumApplicationAmount",currency,updated_at::text as "updatedAt"
    from financing_providers order by audience,name`);
});

export const saveFinancingProviderAdmin = createServerFn({method:"POST"}).middleware([authMiddleware]).validator(providerSchema).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context); await requireAdminForUserId(userId, "admin.financing.manage"); await requireFreshSession();
  await enforceRateLimit("admin-financing-provider-save",{windowSeconds:3600,maxRequests:30,subject:userId});
  if(data.audience==="customer" && !["bnpl","installment"].includes(data.productType)) throw new Error("Invalid customer financing product");
  if(data.audience==="merchant" && !["merchant_cash_advance","line_of_credit","term_loan"].includes(data.productType)) throw new Error("Invalid merchant financing product");
  if(data.minimumApplicationAmount && data.maximumApplicationAmount && data.minimumApplicationAmount>data.maximumApplicationAmount) throw new Error("Invalid financing amount range");
  return withTransaction(async(sql)=>{
  await sql.query(`insert into financing_providers(
      id,provider_key,name,provider_legal_name,audience,product_type,status,marketplace_enabled,
      marketplace_partner_status,security_review_status,integration_status,commercial_status,customer_channel_enabled,
      provider_supplied_reference,integration_mode,application_url,terms_url,privacy_url,minimum_application_amount,maximum_application_amount,currency,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'GHS',now())
    on conflict(id) do update set provider_key=excluded.provider_key,name=excluded.name,provider_legal_name=excluded.provider_legal_name,
      audience=excluded.audience,product_type=excluded.product_type,status=excluded.status,marketplace_enabled=excluded.marketplace_enabled,
      marketplace_partner_status=excluded.marketplace_partner_status,security_review_status=excluded.security_review_status,
      integration_status=excluded.integration_status,commercial_status=excluded.commercial_status,customer_channel_enabled=excluded.customer_channel_enabled,
      provider_supplied_reference=excluded.provider_supplied_reference,integration_mode=excluded.integration_mode,application_url=excluded.application_url,
      terms_url=excluded.terms_url,privacy_url=excluded.privacy_url,minimum_application_amount=excluded.minimum_application_amount,
      maximum_application_amount=excluded.maximum_application_amount,updated_at=now()`,
    [data.id,data.providerKey,data.name,data.providerLegalName,data.audience,data.productType,data.status,data.marketplaceEnabled,
     data.marketplacePartnerStatus,data.securityReviewStatus,data.integrationStatus,data.commercialStatus,data.customerChannelEnabled,
     data.providerSuppliedReference??null,data.integrationMode,data.applicationUrl??null,data.termsUrl,data.privacyUrl,
     data.minimumApplicationAmount??null,data.maximumApplicationAmount??null]);
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[
    "admin.financing_provider.saved","financing_provider",data.id,userId,"admin",null,"success",
    JSON.stringify({providerKey:data.providerKey,audience:data.audience,productType:data.productType,enabled:data.marketplaceEnabled,
      marketplacePartnerStatus:data.marketplacePartnerStatus,securityReviewStatus:data.securityReviewStatus,
      integrationStatus:data.integrationStatus,commercialStatus:data.commercialStatus,customerChannelEnabled:data.customerChannelEnabled,
      integrationMode:data.integrationMode,reason:data.reason})
  ]);
  return {saved:true};
  });
});
