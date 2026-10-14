import { createServerFn } from "@tanstack/react-start";
import { getSql, withTransaction } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { z } from "zod";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AdminMerchantReview = {
  id: string;
  businessName: string;
  category: string;
  categories: string[];
  contact: string;
  status: string;
  createdAt: string;
  businessNumber: string;
  taxpayerIdMasked: string | null;
  taxRegistrationStatus: string | null;
  vatRegistrationStatus: string | null;
  verification: {
    email: string;
    phone: string;
    identity: string;
    business: string;
    document: string;
    payout: string;
  };
};

export type AdminDashboardData = {
  metrics: {
    merchantReviews: number;
    pendingPayments: number;
    rejectedWebhooks24h: number;
    errors24h: number;
    activeMerchants: number;
    refundExceptions: number;
    ordersToday: number;
    overdueMerchantReviews: number;
    stalePaymentAttempts: number;
    openRiskFlags: number;
    pendingProviderApplications: number;
  };
  merchantReviews: AdminMerchantReview[];
  paymentExceptions: Array<{
    id: string;
    status: string;
    providerKey: string;
    amount: string;
    createdAt: string;
    failureCode: string | null;
  }>;
  refundRequests: Array<{
    id: string;
    orderId: string;
    paymentId: string;
    status: string;
    amount: string;
    reason: string | null;
    providerRefundId: string | null;
    createdAt: string;
  }>;
  riskFlags: Array<{
    id: string; subjectType: string; subjectId: string; flagCode: string; severity: string;
    status: string; evidence: JsonValue; createdAt: string;
  }>;
  auditEvents: Array<{
    id: number;
    eventType: string;
    resourceType: string;
    resourceId: string | null;
    outcome: string;
    actorRole: string | null;
    createdAt: string;
  }>;
  catalogTaxonomy: Array<{
    key: string;
    name: string;
    active: boolean;
    activeProducts: number;
    subcategories: Array<{ key: string; name: string; active: boolean; activeProducts: number }>;
  }>;
};

export const loadAdminDashboard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<AdminDashboardData> => {
    const userId = getAuthenticatedUserId(context);
    await requireAdminForUserId(userId);
    const sql = await getSql();

    const merchantReviews = await sql.query<{ n: number }>(
        `select count(*)::int as n from merchant_applications where status in ('pending','reviewing')`,
      );
    const pendingPayments = await sql.query<{ n: number }>(
        `select count(*)::int as n from payment_attempts where status in ('initiated','pending','authorized')`,
      );
    const rejectedWebhooks24h = await sql.query<{ n: number }>(
        `select count(*)::int as n from payment_webhook_rejections where rejected_at>now()-interval '24 hours'`,
      );
    const errors24h = await sql.query<{ n: number }>(
        `select count(*)::int as n from observability_events where severity='error' and created_at>now()-interval '24 hours'`,
      );
    const activeMerchants = await sql.query<{ n: number }>(
        `select count(*)::int as n from merchants where status='active'`,
      );
    const refundExceptions = await sql.query<{ n: number }>(
        `select ((select count(*) from provider_refund_requests where status in ('needs_attention','failed')) + (select count(*) from marketplace_reconciliation_cases where case_type='payment' and status in ('open','investigating')))::int as n`,
      );
    const ordersToday = await sql.query<{ n: number }>(
        `select count(*)::int as n from orders where created_at >= current_date`,
      );
    // Ops thresholds are configurable rather than vendor- or code-driven policy.
    const reviewSlaHours = Math.max(1, Math.min(720, Number(process.env.ADMIN_REVIEW_SLA_HOURS) || 48));
    const paymentDelayMinutes = Math.max(5, Math.min(1440, Number(process.env.ADMIN_PAYMENT_ALERT_MINUTES) || 30));
    const exceptionCounts = await sql.query<{overdue_reviews:number;stale_payments:number;open_risk:number;pending_partners:number}>(
      `select
         (select count(*)::int from merchant_applications where status in ('pending','reviewing')
           and created_at<now()-($1::int*interval '1 hour')) as overdue_reviews,
         (select count(*)::int from payment_attempts where status in ('initiated','pending','authorized')
           and created_at<now()-($2::int*interval '1 minute')) as stale_payments,
         (select count(*)::int from risk_flags where status='open') as open_risk,
         (select count(*)::int from provider_gateway_applications where status in ('review','information_requested')) as pending_partners`,
      [Math.round(reviewSlaHours),Math.round(paymentDelayMinutes)],
    );
    const merchantRows = await sql.query<{
        id: string;
        business_name: string;
        category: string;
        catalog_categories: string[];
        contact: string;
        registration_number: string;
        taxpayer_id_last4: string | null;
        tax_registration_status: string | null;
        vat_registration_status: string | null;
        status: string;
        created_at: string;
        email_status: string;
        phone_status: string;
        identity_status: string;
        business_status: string;
        document_status: string;
        payout_status: string;
      }>(
        `select
           a.id,
           a.business_name,
           a.category,
           a.catalog_categories,
           a.contact,
           a.registration_number,
           a.taxpayer_id_last4,
           a.tax_registration_status,
           a.vat_registration_status,
           a.status,
           to_char(a.created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as created_at,
           coalesce(v.email_status,'pending') as email_status,
           coalesce(v.phone_status,'pending') as phone_status,
           coalesce(v.identity_status,'not_started') as identity_status,
           coalesce(v.business_status,'not_started') as business_status,
           coalesce(v.document_status,'not_started') as document_status,
           coalesce(v.payout_status,'not_started') as payout_status
         from merchant_applications a
         left join lateral (
           select
             max(status) filter (where check_type='email') as email_status,
             max(status) filter (where check_type='phone') as phone_status,
             max(status) filter (where check_type='identity') as identity_status,
             max(status) filter (where check_type='business') as business_status,
             max(status) filter (where check_type='document') as document_status,
             max(status) filter (where check_type='payout') as payout_status
           from merchant_verification_checks
           where application_id=a.id
         ) v on true
         where a.status in ('pending','reviewing')
         order by a.created_at asc
         limit 50`,
      );
    const paymentRows = await sql.query<{
        id: string;
        status: string;
        provider_key: string;
        amount: string;
        created_at: string;
        failure_code: string | null;
      }>(
        `select
           pa.id,
           pa.status,
           pa.provider_key,
           pa.amount::text as amount,
           to_char(pa.created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as created_at,
           pa.failure_code
         from payment_attempts pa
         where pa.status in ('initiated','pending','authorized','failed')
         order by pa.updated_at desc
         limit 30`,
      );
    const refundRows = await sql.query<{
        id: string;
        order_id: string;
        payment_id: string;
        status: string;
        amount: string;
        reason: string | null;
        provider_refund_id: string | null;
        created_at: string;
      }>(
        `select id, order_id, payment_id, status, amount::text as amount, reason,
                provider_refund_id,
                to_char(requested_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as created_at
         from provider_refund_requests
         where status in ('requested','processing','needs_attention','failed')
         order by requested_at asc
         limit 30`,
      );
    const riskFlagRows = await sql.query<{
        id: string; subject_type: string; subject_id: string; flag_code: string; severity: string;
        status: string; evidence: JsonValue; created_at: string;
      }>(`
        select id,subject_type,subject_id,flag_code,severity,status,evidence,
               to_char(created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as created_at
          from risk_flags
         where status='open'
         order by created_at desc limit 50
      `);
    const auditRows = await sql.query<{
        id: number;
        event_type: string;
        resource_type: string;
        resource_id: string | null;
        outcome: string;
        actor_role: string | null;
        created_at: string;
      }>(
        `select id, event_type, resource_type, resource_id, outcome, actor_role,
                to_char(created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as created_at
         from audit_events
         order by created_at desc
         limit 40`,
      );

    const taxonomyRows = await sql.query<{ category_key:string; category_name:string; category_active:boolean; subcategory_key:string|null; subcategory_name:string|null; subcategory_active:boolean|null; active_products:number }>(
      `select c.category_key,c.name as category_name,c.active as category_active,
              s.subcategory_key,s.name as subcategory_name,s.active as subcategory_active,
              count(p.id)::int as active_products
         from category_taxonomy c
         left join category_subcategories s on s.category_key=c.category_key
         left join products p on p.category=c.category_key
              and p.status='active'
              and (s.subcategory_key is null or p.subcategory=s.subcategory_key)
        group by c.category_key,c.name,c.active,c.sort_order,s.subcategory_key,s.name,s.active,s.sort_order
        order by c.sort_order,c.category_key,s.sort_order nulls first,s.subcategory_key`
    );
    const catalogTaxonomy = Array.from(new Set(taxonomyRows.map(row=>row.category_key))).map((key)=>{
      const rows=taxonomyRows.filter(row=>row.category_key===key);
      const first=rows[0]!;
      const directCategoryProducts = rows.filter(row=>row.subcategory_key==null).reduce((sum,row)=>sum+Number(row.active_products||0),0);
      const subcategories=rows.filter(row=>row.subcategory_key!=null).map(row=>({
        key:row.subcategory_key!,name:row.subcategory_name!,active:Boolean(row.subcategory_active),activeProducts:Number(row.active_products||0),
      }));
      return {key,name:first.category_name,active:Boolean(first.category_active),activeProducts:directCategoryProducts+subcategories.reduce((sum,row)=>sum+row.activeProducts,0),subcategories};
    });

    return {
      metrics: {
        merchantReviews: merchantReviews[0]?.n ?? 0,
        pendingPayments: pendingPayments[0]?.n ?? 0,
        rejectedWebhooks24h: rejectedWebhooks24h[0]?.n ?? 0,
        errors24h: errors24h[0]?.n ?? 0,
        activeMerchants: activeMerchants[0]?.n ?? 0,
        refundExceptions: refundExceptions[0]?.n ?? 0,
        ordersToday: ordersToday[0]?.n ?? 0,
        overdueMerchantReviews: exceptionCounts[0]?.overdue_reviews ?? 0,
        stalePaymentAttempts: exceptionCounts[0]?.stale_payments ?? 0,
        openRiskFlags: exceptionCounts[0]?.open_risk ?? 0,
        pendingProviderApplications: exceptionCounts[0]?.pending_partners ?? 0,
      },
      catalogTaxonomy,
      merchantReviews: merchantRows.map((row) => ({
        id: row.id,
        businessName: row.business_name,
        category: row.category,
        categories: row.catalog_categories?.length ? row.catalog_categories : [row.category],
        contact: row.contact,
        businessNumber: row.registration_number,
        taxpayerIdMasked: row.taxpayer_id_last4 ? `••••${row.taxpayer_id_last4}` : null,
        taxRegistrationStatus: row.tax_registration_status,
        vatRegistrationStatus: row.vat_registration_status,
        status: row.status,
        createdAt: row.created_at,
        verification: {
          email: row.email_status,
          phone: row.phone_status,
          identity: row.identity_status,
          business: row.business_status,
          document: row.document_status,
          payout: row.payout_status,
        },
      })),
      paymentExceptions: paymentRows.map((row) => ({
        id: row.id,
        status: row.status,
        providerKey: row.provider_key,
        amount: row.amount,
        createdAt: row.created_at,
        failureCode: row.failure_code,
      })),
      refundRequests: refundRows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        paymentId: row.payment_id,
        status: row.status,
        amount: row.amount,
        reason: row.reason,
        providerRefundId: row.provider_refund_id,
        createdAt: row.created_at,
      })),
      riskFlags: riskFlagRows.map((row) => ({
        id: row.id, subjectType: row.subject_type, subjectId: row.subject_id, flagCode: row.flag_code, severity: row.severity,
        status: row.status, evidence: row.evidence, createdAt: row.created_at,
      })),
      auditEvents: auditRows.map((row) => ({
        id: Number(row.id),
        eventType: row.event_type,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        outcome: row.outcome,
        actorRole: row.actor_role,
        createdAt: row.created_at,
      })),
    };
  });


const sensitiveRevealSchema = z.object({ applicationId: z.string().min(1).max(128) });

export const viewMerchantSensitiveData = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(sensitiveRevealSchema)
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    await requireAdminForUserId(adminId);
    await requireFreshSession();
    const sql = await getSql();
    const rows = await sql.query<{
      registration_number: string;
      taxpayer_id_type: string;
      taxpayer_id_encrypted: string;
      business_type: string;
      tax_registration_status: string;
      vat_registration_status: string | null;
    }>(`select registration_number,taxpayer_id_type,taxpayer_id_encrypted,business_type,
              tax_registration_status,vat_registration_status
         from merchant_applications where id=$1 limit 1`, [data.applicationId]);
    const row = rows[0];
    if (!row) throw new Error("Merchant application not found");
    const { decryptMerchantSensitiveData } = await import("@/lib/security/merchant-sensitive.server");
    const taxpayerId = decryptMerchantSensitiveData<string>(row.taxpayer_id_encrypted);
    await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
      "admin.merchant.sensitive_data.viewed", "merchant_application", data.applicationId, adminId, "admin", null, "success",
      JSON.stringify({ fields: ["taxpayerId"], taxpayerIdType: row.taxpayer_id_type }),
    ]);
    return {
      businessNumber: row.registration_number,
      taxpayerIdType: row.taxpayer_id_type,
      taxpayerId,
      businessType: row.business_type,
      taxRegistrationStatus: row.tax_registration_status,
      vatRegistrationStatus: row.vat_registration_status,
    };
  });


const providerRefundSchema = z.object({
  orderId: z.string().min(1).max(128),
  note: z.string().trim().min(12).max(2000),
});

export const requestAdminProviderRefund = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(providerRefundSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await requireAdminForUserId(userId, "admin.finance.refunds");
    await requireFreshSession();
    await enforceRateLimit("admin-provider-refund", { windowSeconds: 300, maxRequests: 10, subject: userId });
    // Order lock, idempotent provider-refund preparation, and audit commit atomically.
    // The actual external API call runs AFTER commit; it must never occur inside a DB lock.
    const requestId = await withTransaction(async (sql) => {
      const rows = await sql.query<{ payment_id: string | null }>(
        `select payment_id from orders where id=$1 for update`, [data.orderId],
      );
      const paymentId = rows[0]?.payment_id;
      if (!paymentId) throw new Error("Order has no completed payment");
      const prepared = await sql.query<{ result: unknown }>(
        `select prepare_provider_refund_for_payment($1,$2,$3) as result`,
        [paymentId, userId, "admin_refund_request"],
      );
      const result = prepared[0]?.result as { requestId?: string } | null;
      if (!result?.requestId) throw new Error("Provider refund request could not be prepared");
      await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
        "admin.refund.execution_requested", "order", data.orderId, userId, "admin", null, "success",
        JSON.stringify({refundRequestId:result.requestId,reason:data.note.trim()}),
      ]);
      return String(result.requestId);
    });
    const { executeProviderRefundAsAdmin } = await import("@/modules/payments/public/refunds.server");
    return await executeProviderRefundAsAdmin(requestId);
  });



const catalogTaxonomyStateSchema = z.object({
  scope: z.enum(["category","subcategory"]),
  categoryKey: z.string().trim().min(1).max(120),
  subcategoryKey: z.string().trim().min(1).max(120).nullable().optional(),
  active: z.boolean(),
  reason: z.string().trim().min(5).max(2000),
});

export const setCatalogTaxonomyState = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(catalogTaxonomyStateSchema)
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    await requireAdminForUserId(adminId, "admin.categories.manage");
    await requireFreshSession();
    await enforceRateLimit("admin-catalog-taxonomy-state", { windowSeconds: 60, maxRequests: 30, subject: adminId });
    const sql = await getSql();
    const rows = await sql.query<{ result: { scope:string; categoryKey:string; subcategoryKey:string|null; active:boolean } }>(
      `with identity as (select set_config('app.user_id',$1,true) as user_id)
        select admin_set_catalog_taxonomy_state($1,$2,$3,$4,$5,$6) as result from identity`,
      [adminId,data.scope,data.categoryKey,data.scope === "subcategory" ? (data.subcategoryKey ?? null) : null,data.active,data.reason],
    );
    return rows[0]?.result ?? { scope:data.scope, categoryKey:data.categoryKey, subcategoryKey:data.subcategoryKey ?? null, active:data.active };
  });
