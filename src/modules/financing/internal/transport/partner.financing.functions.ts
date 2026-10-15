import type { JsonObject } from "@/lib/db-types";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { getSql, withTransaction } from "@/lib/db";
import { requirePartnerAccess, requirePartnerAdmin } from "@/lib/partner/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const terminalCaseStatuses = new Set(["completed", "declined", "cancelled"]);

const hasAtMostTwoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
const positiveMoney = z.number().finite().positive().max(100_000_000).refine(hasAtMostTwoDecimals, "Amount must have at most two decimal places");
const nonNegativeMoney = z.number().finite().nonnegative().max(100_000_000).refine(hasAtMostTwoDecimals, "Amount must have at most two decimal places");

export const loadFinancingPartnerDashboard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = getAuthenticatedUserId(context);
    const sql = await getSql();
    const accesses = [];
    for (const capability of ["customer_financing", "merchant_financing"] as const) {
      try {
        accesses.push({ capability, ...(await requirePartnerAccess(userId, capability)) });
      } catch {
        // Absence of one capability is expected; all failures are handled below.
      }
    }
    if (!accesses.length) throw new Error("Financing partner access denied");
    const orgId = accesses[0].organizationId;
    if (accesses.some((x) => x.organizationId !== orgId)) {
      throw new Error("Ambiguous financing partner organization access");
    }
    const allowedAudiences = accesses.map((x) => x.capability === "customer_financing" ? "customer" : "merchant");
    const providers = await sql.query<JsonObject>(
      `select id,name,audience,product_type as "productType",status,integration_mode as "integrationMode",marketplace_partner_status as "marketplacePartnerStatus",security_review_status as "securityReviewStatus",integration_status as "integrationStatus",commercial_status as "commercialStatus",customer_channel_enabled as "customerChannelEnabled",provider_supplied_reference as "providerSuppliedReference" from financing_providers where partner_organization_id=$1 and audience=any($2::text[]) order by audience,name`,
      [orgId, allowedAudiences],
    );
    const customer = allowedAudiences.includes("customer") ? await sql.query<JsonObject>(
      `select a.id,'customer' as audience,a.amount::float8 as amount,a.currency,a.status,a.provider_reference as "providerReference",
              a.initial_contribution_amount::float8 as "initialDepositAmount",a.initial_deposit_status as "initialDepositStatus",
              a.provider_form_id as "providerFormId",a.created_at::text as "createdAt",p.name as "providerName"
         from customer_financing_applications a
         join financing_providers p on p.id=a.provider_id and p.partner_organization_id=$1 and p.audience='customer'
        order by a.created_at desc limit 150`,
      [orgId],
    ) : [];
    const merchant = allowedAudiences.includes("merchant") ? await sql.query<JsonObject>(
      `select a.id,'merchant' as audience,a.requested_amount::float8 as amount,a.currency,a.status,a.provider_reference as "providerReference",a.score_snapshot as "scoreSnapshot",a.created_at::text as "createdAt",p.name as "providerName",m.name as "merchantName" from merchant_financing_applications a join financing_providers p on p.id=a.provider_id and p.partner_organization_id=$1 and p.audience='merchant' join merchants m on m.id=a.merchant_id order by a.created_at desc limit 150`,
      [orgId],
    ) : [];
    const cases = await sql.query<JsonObject>(
      `select id,application_audience as audience,application_id as "applicationId",workflow_status as "workflowStatus",assigned_to_user_id as "assignedToUserId",sla_due_at::text as "slaDueAt",version from financing_application_cases where organization_id=$1 and application_audience=any($2::text[]) order by sla_due_at asc limit 250`,
      [orgId, allowedAudiences],
    );
    const offers = await sql.query<JsonObject>(
      `select o.id,o.case_id as "caseId",o.amount::float8 as amount,o.currency,o.status,o.expires_at::text as "expiresAt",o.created_at::text as "createdAt" from financing_offers o join financing_application_cases c on c.id=o.case_id and c.organization_id=o.organization_id where o.organization_id=$1 and c.application_audience=any($2::text[]) order by o.created_at desc limit 300`,
      [orgId, allowedAudiences],
    );
    return {
      organization: accesses[0].organizationName,
      role: accesses[0].role,
      capabilities: accesses.map((x) => x.capability),
      providers,
      applications: [...customer, ...merchant]
        .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 200),
      cases,
      offers,
    };
  });

const decisionSchema = z
  .object({
    applicationId: z.string().min(1).max(128),
    audience: z.enum(["customer", "merchant"]),
    decision: z.enum(["approved", "declined"]),
    providerReference: z.string().trim().min(1).max(200),
    approvedAmount: positiveMoney.optional(),
    reasonCode: z.string().trim().max(100).optional(),
    idempotencyKey: z.string().trim().min(8).max(128),
  })
  .superRefine((v, c) => {
    if (v.decision === "approved" && !v.approvedAmount) {
      c.addIssue({ code: "custom", message: "Approved amount required", path: ["approvedAmount"] });
    }
    if (v.decision === "declined" && v.approvedAmount) {
      c.addIssue({ code: "custom", message: "Decline cannot include approved amount", path: ["approvedAmount"] });
    }
  });

export const recordFinancingDecision = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(decisionSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const capability = data.audience === "customer" ? "customer_financing" : "merchant_financing";
    const access = await requirePartnerAccess(userId, capability, true);
    await enforceRateLimit("partner-financing-decision", {
      windowSeconds: 60,
      maxRequests: 30,
      subject: `${access.organizationId}:${userId}`,
    });

    return withTransaction(async (sql) => {
      await sql.query(`select pg_advisory_xact_lock(hashtext($1))`, [
        `elemarket:financing-decision:${access.organizationId}:${data.idempotencyKey}`,
      ]);
      const table = data.audience === "customer" ? "customer_financing_applications" : "merchant_financing_applications";
      const amountCol = data.audience === "customer" ? "amount" : "requested_amount";
      const replay = await sql.query<{
        applicationId: string;
        audience: string;
        decision: string;
        providerReference: string;
        approvedAmount: number | null;
        reasonCode: string | null;
      }>(
        `select application_id as "applicationId",application_audience as audience,decision,provider_reference as "providerReference",approved_amount::float8 as "approvedAmount",reason_code as "reasonCode" from financing_provider_decisions where organization_id=$1 and idempotency_key=$2`,
        [access.organizationId, data.idempotencyKey],
      );
      if (replay.length) {
        const r = replay[0];
        const same =
          r.applicationId === data.applicationId &&
          r.audience === data.audience &&
          r.decision === data.decision &&
          r.providerReference === data.providerReference &&
          (r.approvedAmount ?? null) === (data.approvedAmount ?? null) &&
          (r.reasonCode ?? null) === (data.reasonCode ?? null);
        if (!same) throw new Error("Idempotency key already used with a different financing decision payload");
        return { recorded: true, replayed: true };
      }

      const depositStatusExpr = data.audience === "customer" ? `a.initial_deposit_status` : `'not_required'`;
      const apps = await sql.query<{ id: string; providerId: string; amount: number; currency: string; status: string; supervisorRequired: boolean; initialDepositStatus: string }>(
        `select a.id,a.provider_id as "providerId",a.${amountCol}::float8 as amount,a.currency,a.status,
                p.supervisor_approval_required as "supervisorRequired",${depositStatusExpr} as "initialDepositStatus"
           from ${table} a
           join financing_providers p on p.id=a.provider_id and p.partner_organization_id=$2
          where a.id=$1 for update`,
        [data.applicationId, access.organizationId],
      );
      if (apps.length !== 1) throw new Error("Financing application not found");
      const app = apps[0];
      if (!["started", "pending"].includes(app.status)) throw new Error("Financing application is not decisionable");
      if (data.decision === "approved" && data.audience === "customer" && !["not_required","paid"].includes(app.initialDepositStatus)) {
        throw new Error("Required customer initial deposit has not been confirmed");
      }
      if (data.approvedAmount && data.approvedAmount > app.amount) throw new Error("Approved amount exceeds requested amount");

      const caseRows = await sql.query<{ id: string; workflowStatus: string }>(
        `select id,workflow_status as "workflowStatus" from financing_application_cases where organization_id=$1 and provider_id=$2 and application_audience=$3 and application_id=$4 for update`,
        [access.organizationId, app.providerId, data.audience, app.id],
      );
      if (caseRows.length !== 1) throw new Error("Financing operational case is missing");
      if (terminalCaseStatuses.has(caseRows[0].workflowStatus)) throw new Error("Financing case is already closed");
      if (data.decision === "approved" && app.supervisorRequired) {
        const approvedOffers = await sql.query<{ amount: number }>(
          `select amount::float8 as amount from financing_offers where case_id=$1 and organization_id=$2 and provider_id=$3 and status='issued' and approved_by_user_id is not null and expires_at>now() order by issued_at desc limit 1 for share`,
          [caseRows[0].id, access.organizationId, app.providerId],
        );
        if (approvedOffers.length !== 1) throw new Error("Supervisor-approved financing offer is required before approval");
        if (Number(approvedOffers[0].amount) !== Number(data.approvedAmount)) {
          throw new Error("Approved amount must match the supervisor-approved offer");
        }
      }

      const decisionId = `fd_${crypto.randomUUID()}`;
      await sql.query(
        `insert into financing_provider_decisions(id,organization_id,provider_id,application_audience,application_id,decision,provider_reference,approved_amount,currency,reason_code,decided_by_user_id,idempotency_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [decisionId, access.organizationId, app.providerId, data.audience, app.id, data.decision, data.providerReference, data.approvedAmount ?? null, app.currency, data.reasonCode ?? null, userId, data.idempotencyKey],
      );
      if (data.audience === "customer") {
        await sql.query(
          `update customer_financing_applications set status=$2,provider_reference=$3,provider_decision_at=now(),approved_amount=$4,approved_currency=case when $2='approved' then currency else null end,intent_closed_at=case when $2='declined' then coalesce(intent_closed_at,now()) else intent_closed_at end,updated_at=now() where id=$1`,
          [app.id, data.decision, data.providerReference, data.approvedAmount ?? null],
        );
      } else {
        await sql.query(
          `update merchant_financing_applications set status=$2,provider_reference=$3,exposure_closed_at=case when $2='declined' then coalesce(exposure_closed_at,now()) else exposure_closed_at end,updated_at=now() where id=$1`,
          [app.id, data.decision, data.providerReference],
        );
      }
      const nextWorkflow = data.decision === "approved" ? "approved" : "declined";
      await sql.query(
        `update financing_application_cases set workflow_status=$2,last_activity_at=now(),updated_at=now(),version=version+1 where id=$1`,
        [caseRows[0].id, nextWorkflow],
      );
      await sql.query(
        `insert into financing_case_events(id,case_id,organization_id,actor_user_id,event_type,metadata) values($1,$2,$3,$4,'provider_decision',$5::jsonb)`,
        [`fce_${crypto.randomUUID()}`, caseRows[0].id, access.organizationId, userId, JSON.stringify({ decision: data.decision })],
      );
      await sql.query(
        `insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'financing.provider_decision','financing_application',$3,'success',$4::jsonb)`,
        [access.organizationId, userId, app.id, JSON.stringify({ audience: data.audience, decision: data.decision })],
      );
      return { recorded: true, replayed: false };
    });
  });

const caseActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), caseId: z.string().min(1).max(128), assigneeUserId: z.literal("self"), expectedVersion: z.number().int().nonnegative() }),
  z.object({ action: z.literal("start_review"), caseId: z.string().min(1).max(128), expectedVersion: z.number().int().nonnegative() }),
  z.object({ action: z.literal("request_information"), caseId: z.string().min(1).max(128), requestText: z.string().trim().min(3).max(2000), expectedVersion: z.number().int().nonnegative() }),
  z.object({ action: z.literal("add_note"), caseId: z.string().min(1).max(128), note: z.string().trim().min(1).max(4000), expectedVersion: z.number().int().nonnegative() }),
]);

export const updateFinancingCase = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(caseActionSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const probe = await getSql();
    const seed = await probe.query<any>(
      `select organization_id as "organizationId",application_audience as audience from financing_application_cases where id=$1`,
      [data.caseId],
    );
    if (seed.length !== 1) throw new Error("Financing case not found");
    const capability = seed[0].audience === "customer" ? "customer_financing" : "merchant_financing";
    const access = await requirePartnerAccess(userId, capability, true);
    if (access.organizationId !== seed[0].organizationId) throw new Error("Financing case access denied");
    await enforceRateLimit("partner-financing-case", {
      windowSeconds: 60,
      maxRequests: 60,
      subject: `${access.organizationId}:${userId}`,
    });

    return withTransaction(async (sql) => {
      const rows = await sql.query<any>(
        `select id,organization_id as "organizationId",application_audience as audience,workflow_status as status,version from financing_application_cases where id=$1 and organization_id=$2 for update`,
        [data.caseId, access.organizationId],
      );
      if (rows.length !== 1) throw new Error("Financing case not found");
      const current = rows[0];
      if (Number(current.version) !== data.expectedVersion) throw new Error("Financing case changed; refresh and retry");

      const allowed: Record<string, string[]> = {
        assign: ["new", "assigned", "under_review", "information_requested"],
        start_review: ["new", "assigned", "information_requested"],
        request_information: ["new", "assigned", "under_review", "information_requested"],
      };
      if (data.action !== "add_note" && !allowed[data.action].includes(current.status)) {
        throw new Error("Financing case action is not valid in the current workflow state");
      }

      let next = current.status;
      if (data.action === "assign") next = "assigned";
      if (data.action === "start_review") next = "under_review";
      if (data.action === "request_information") next = "information_requested";

      const updated = await sql.query(
        `update financing_application_cases set workflow_status=$2,assigned_to_user_id=case when $3='assign' then $4 else assigned_to_user_id end,assigned_at=case when $3='assign' then now() else assigned_at end,last_activity_at=now(),updated_at=now(),version=version+1 where id=$1 and organization_id=$5 and version=$6 returning id`,
        [data.caseId, next, data.action, data.action === "assign" ? userId : null, access.organizationId, data.expectedVersion],
      );
      if (!updated.length) throw new Error("Financing case changed; refresh and retry");

      if (data.action === "request_information") {
        await sql.query(
          `insert into financing_information_requests(id,case_id,organization_id,requested_by_user_id,request_text) values($1,$2,$3,$4,$5)`,
          [`fir_${crypto.randomUUID()}`, data.caseId, access.organizationId, userId, data.requestText],
        );
      }
      await sql.query(
        `insert into financing_case_events(id,case_id,organization_id,actor_user_id,event_type,note,metadata) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          `fce_${crypto.randomUUID()}`,
          data.caseId,
          access.organizationId,
          userId,
          data.action === "add_note" ? "internal_note" : data.action,
          data.action === "add_note" ? data.note : null,
          JSON.stringify(data.action === "add_note" ? {} : { to: next }),
        ],
      );
      return { updated: true };
    });
  });

const offerSchema = z
  .object({
    caseId: z.string().min(1).max(128),
    amount: positiveMoney,
    currency: z.string().length(3).transform((x) => x.toUpperCase()),
    depositAmount: nonNegativeMoney.optional(),
    tenureMonths: z.number().int().min(1).max(120).optional(),
    expiresAt: z.string().datetime(),
    providerTerms: z.record(z.string(), z.unknown()).default({}),
    expectedVersion: z.number().int().nonnegative(),
  })
  .superRefine((v, c) => {
    if (v.depositAmount != null && v.depositAmount > v.amount) {
      c.addIssue({ code: "custom", message: "Deposit cannot exceed offer amount", path: ["depositAmount"] });
    }
  });

export const createFinancingOffer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(offerSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const probe = await getSql();
    const seed = await probe.query<any>(
      `select organization_id as "organizationId",application_audience as audience from financing_application_cases where id=$1`,
      [data.caseId],
    );
    if (seed.length !== 1) throw new Error("Financing case not found");
    const capability = seed[0].audience === "customer" ? "customer_financing" : "merchant_financing";
    const access = await requirePartnerAccess(userId, capability, true);
    if (access.organizationId !== seed[0].organizationId) throw new Error("Financing case access denied");
    await enforceRateLimit("partner-financing-offer", {
      windowSeconds: 60,
      maxRequests: 30,
      subject: `${access.organizationId}:${userId}`,
    });

    return withTransaction(async (sql) => {
      const cases = await sql.query<any>(
        `select c.*,p.supervisor_approval_required as "supervisorRequired",p.marketplace_partner_status,p.security_review_status,p.integration_status,p.commercial_status,p.customer_channel_enabled from financing_application_cases c join financing_providers p on p.id=c.provider_id where c.id=$1 and c.organization_id=$2 for update of c`,
        [data.caseId, access.organizationId],
      );
      if (cases.length !== 1) throw new Error("Financing case not found");
      const c = cases[0];
      if (Number(c.version) !== data.expectedVersion) throw new Error("Financing case changed; refresh and retry");
      const expiryMs = new Date(data.expiresAt).getTime();
      if (expiryMs <= Date.now()) throw new Error("Offer expiry must be in the future");
      if (expiryMs > Date.now() + 366 * 86_400_000) throw new Error("Offer expiry is unreasonably far in the future");
      if (
        c.marketplace_partner_status !== "active" ||
        !["passed", "waived"].includes(c.security_review_status) ||
        c.integration_status !== "ready" ||
        c.commercial_status !== "active" ||
        !c.customer_channel_enabled
      ) {
        throw new Error("Provider is not enabled for ELEMARKET customer-facing financing");
      }
      if (["approved", "declined", "disbursed", "repaying", "completed", "cancelled"].includes(c.workflow_status)) {
        throw new Error("Financing case is closed for new offers");
      }
      if (["awaiting_supervisor", "offer_issued"].includes(c.workflow_status)) {
        const activeOffers = await sql.query<any>(
          `select id,status,expires_at::text as "expiresAt" from financing_offers where case_id=$1 and organization_id=$2 and status in ('draft','pending_supervisor','issued','accepted') order by created_at desc for update`,
          [c.id, access.organizationId],
        );
        const active = activeOffers[0];
        if (active && Date.parse(active.expiresAt) <= Date.now() && active.status !== "accepted") {
          await sql.query(`update financing_offers set status='expired',updated_at=now() where id=$1`, [active.id]);
          await sql.query(
            `update financing_application_cases set workflow_status='under_review',last_activity_at=now(),updated_at=now(),version=version+1 where id=$1`,
            [c.id],
          );
          return { offerId: active.id, status: "expired_refresh_required" };
        }
        throw new Error("An active financing offer already exists for this case");
      }
      if (!["new", "assigned", "under_review", "information_requested", "offer_declined"].includes(c.workflow_status)) {
        throw new Error("Financing case is not eligible for a new offer");
      }

      const appRows =
        c.application_audience === "customer"
          ? await sql.query<any>(`select amount::float8 as amount,currency,status from customer_financing_applications where id=$1 and provider_id=$2 for update`, [c.application_id, c.provider_id])
          : await sql.query<any>(`select requested_amount::float8 as amount,currency,status from merchant_financing_applications where id=$1 and provider_id=$2 for update`, [c.application_id, c.provider_id]);
      if (appRows.length !== 1) throw new Error("Financing application not found");
      const app = appRows[0];
      if (!["started", "pending"].includes(app.status)) throw new Error("Financing application is not eligible for a new offer");
      if (data.currency !== app.currency) throw new Error("Offer currency does not match application currency");
      if (data.amount > Number(app.amount)) throw new Error("Offer amount exceeds requested amount");

      const status = c.supervisorRequired ? "pending_supervisor" : "issued";
      const id = `fo_${crypto.randomUUID()}`;
      await sql.query(
        `insert into financing_offers(id,case_id,organization_id,provider_id,amount,currency,deposit_amount,tenure_months,provider_terms,status,expires_at,created_by_user_id,issued_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,case when $10='issued' then now() else null end)`,
        [id, c.id, access.organizationId, c.provider_id, data.amount, data.currency, data.depositAmount ?? null, data.tenureMonths ?? null, JSON.stringify(data.providerTerms), status, data.expiresAt, userId],
      );
      const changed = await sql.query(
        `update financing_application_cases set workflow_status=$2,last_activity_at=now(),updated_at=now(),version=version+1 where id=$1 and organization_id=$3 and version=$4 returning id`,
        [c.id, status === "issued" ? "offer_issued" : "awaiting_supervisor", access.organizationId, data.expectedVersion],
      );
      if (!changed.length) throw new Error("Financing case changed; refresh and retry");
      await sql.query(
        `insert into financing_case_events(id,case_id,organization_id,actor_user_id,event_type,metadata) values($1,$2,$3,$4,'offer_created',$5::jsonb)`,
        [`fce_${crypto.randomUUID()}`, c.id, access.organizationId, userId, JSON.stringify({ offerId: id, status })],
      );
      await sql.query(
        `insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'financing.offer_created','financing_offer',$3,'success',$4::jsonb)`,
        [access.organizationId, userId, id, JSON.stringify({ caseId: c.id, status })],
      );
      return { offerId: id, status };
    });
  });

const supervisorOfferSchema = z.object({
  offerId: z.string().min(1).max(128),
  caseId: z.string().min(1).max(128),
  expectedVersion: z.number().int().nonnegative(),
});

export const approveFinancingOffer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(supervisorOfferSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const probe = await getSql();
    const seed = await probe.query<any>(
      `select c.organization_id as "organizationId",c.application_audience as audience from financing_application_cases c join financing_offers o on o.case_id=c.id and o.organization_id=c.organization_id where c.id=$1 and o.id=$2`,
      [data.caseId, data.offerId],
    );
    if (seed.length !== 1) throw new Error("Financing offer not found");
    const capability = seed[0].audience === "customer" ? "customer_financing" : "merchant_financing";
    const access = await requirePartnerAdmin(userId, capability);
    if (access.organizationId !== seed[0].organizationId) throw new Error("Financing offer access denied");
    await enforceRateLimit("partner-financing-supervisor-offer", {
      windowSeconds: 60,
      maxRequests: 30,
      subject: `${access.organizationId}:${userId}`,
    });

    return withTransaction(async (sql) => {
      const rows = await sql.query<any>(
        `select o.id,o.status,o.created_by_user_id as "createdByUserId",o.expires_at::text as "expiresAt",c.id as "caseId",c.version,c.workflow_status as "workflowStatus",p.marketplace_partner_status,p.security_review_status,p.integration_status,p.commercial_status,p.customer_channel_enabled from financing_offers o join financing_application_cases c on c.id=o.case_id and c.organization_id=o.organization_id join financing_providers p on p.id=o.provider_id where o.id=$1 and c.id=$2 and o.organization_id=$3 for update of o,c`,
        [data.offerId, data.caseId, access.organizationId],
      );
      if (rows.length !== 1) throw new Error("Financing offer not found");
      const row = rows[0];
      if (Number(row.version) !== data.expectedVersion) throw new Error("Financing case changed; refresh and retry");
      if (row.status !== "pending_supervisor" || row.workflowStatus !== "awaiting_supervisor") {
        throw new Error("Financing offer is not awaiting supervisor approval");
      }
      if (row.createdByUserId === userId) throw new Error("Supervisor approver must differ from offer creator");
      if (Date.parse(row.expiresAt) <= Date.now()) throw new Error("Financing offer has expired");
      if (
        row.marketplace_partner_status !== "active" ||
        !["passed", "waived"].includes(row.security_review_status) ||
        row.integration_status !== "ready" ||
        row.commercial_status !== "active" ||
        !row.customer_channel_enabled
      ) {
        throw new Error("Provider is not enabled for ELEMARKET customer-facing financing");
      }
      await sql.query(
        `update financing_offers set status='issued',approved_by_user_id=$2,issued_at=now(),updated_at=now() where id=$1 and status='pending_supervisor'`,
        [data.offerId, userId],
      );
      const changed = await sql.query(
        `update financing_application_cases set workflow_status='offer_issued',last_activity_at=now(),updated_at=now(),version=version+1 where id=$1 and organization_id=$2 and version=$3 returning id`,
        [data.caseId, access.organizationId, data.expectedVersion],
      );
      if (!changed.length) throw new Error("Financing case changed; refresh and retry");
      await sql.query(
        `insert into financing_case_events(id,case_id,organization_id,actor_user_id,event_type,metadata) values($1,$2,$3,$4,'offer_supervisor_approved',$5::jsonb)`,
        [`fce_${crypto.randomUUID()}`, data.caseId, access.organizationId, userId, JSON.stringify({ offerId: data.offerId })],
      );
      await sql.query(
        `insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'financing.offer_supervisor_approved','financing_offer',$3,'success',$4::jsonb)`,
        [access.organizationId, userId, data.offerId, JSON.stringify({ caseId: data.caseId })],
      );
      return { approved: true };
    });
  });

const servicingSchema = z.object({
  caseId: z.string().min(1).max(128),
  updateType: z.enum(["purchase_authorized", "disbursed", "repayment_current", "repayment_late", "repayment_completed", "cancelled"]),
  providerReference: z.string().trim().max(200).optional(),
  effectiveAt: z.string().datetime(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const recordFinancingServicingUpdate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(servicingSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    const probe = await getSql();
    const seed = await probe.query<any>(
      `select organization_id as "organizationId",application_audience as audience from financing_application_cases where id=$1`,
      [data.caseId],
    );
    if (seed.length !== 1) throw new Error("Financing case not found");
    const capability = seed[0].audience === "customer" ? "customer_financing" : "merchant_financing";
    const access = await requirePartnerAccess(userId, capability, true);
    if (access.organizationId !== seed[0].organizationId) throw new Error("Financing case access denied");
    await enforceRateLimit("partner-financing-servicing", {
      windowSeconds: 60,
      maxRequests: 60,
      subject: `${access.organizationId}:${userId}`,
    });

    return withTransaction(async (sql) => {
      await sql.query(`select pg_advisory_xact_lock(hashtext($1))`, [
        `elemarket:financing-servicing:${access.organizationId}:${data.idempotencyKey}`,
      ]);
      const replay = await sql.query<any>(
        `select case_id as "caseId",update_type as "updateType",provider_reference as "providerReference",effective_at::text as "effectiveAt" from financing_servicing_updates where organization_id=$1 and idempotency_key=$2`,
        [access.organizationId, data.idempotencyKey],
      );
      if (replay.length) {
        const r = replay[0];
        const same =
          r.caseId === data.caseId &&
          r.updateType === data.updateType &&
          (r.providerReference ?? null) === (data.providerReference ?? null) &&
          new Date(r.effectiveAt).getTime() === new Date(data.effectiveAt).getTime();
        if (!same) throw new Error("Idempotency key already used with a different servicing payload");
        return { recorded: true, replayed: true };
      }

      const cases = await sql.query<any>(
        `select id,organization_id as "organizationId",application_audience as audience,application_id as "applicationId",provider_id as "providerId",workflow_status as "workflowStatus" from financing_application_cases where id=$1 and organization_id=$2 for update`,
        [data.caseId, access.organizationId],
      );
      if (cases.length !== 1) throw new Error("Financing case not found");
      const c = cases[0];
      const effectiveMs = Date.parse(data.effectiveAt);
      if (effectiveMs > Date.now() + 5 * 60_000) throw new Error("Servicing effective time is too far in the future");
      const latest = await sql.query<{ effectiveAt: string }>(
        `select effective_at::text as "effectiveAt" from financing_servicing_updates where case_id=$1 and organization_id=$2 order by effective_at desc,created_at desc,id desc limit 1`,
        [c.id, access.organizationId],
      );
      if (latest[0] && effectiveMs < Date.parse(latest[0].effectiveAt)) {
        throw new Error("Servicing update is older than the latest recorded lifecycle event");
      }

      const appRows =
        c.audience === "customer"
          ? await sql.query<any>(`select status from customer_financing_applications where id=$1 and provider_id=$2 for update`, [c.applicationId, c.providerId])
          : await sql.query<any>(`select status from merchant_financing_applications where id=$1 and provider_id=$2 for update`, [c.applicationId, c.providerId]);
      if (appRows.length !== 1) throw new Error("Financing application not found");
      if (appRows[0].status !== "approved") throw new Error("Servicing requires an approved financing application");

      const allowed: Record<string, string[]> = {
        purchase_authorized: ["approved"],
        disbursed: ["approved"],
        repayment_current: ["disbursed", "repaying"],
        repayment_late: ["disbursed", "repaying"],
        repayment_completed: ["disbursed", "repaying"],
        cancelled: ["approved", "disbursed", "repaying"],
      };
      if (!allowed[data.updateType].includes(c.workflowStatus)) {
        throw new Error("Servicing update is not valid in the current financing lifecycle state");
      }
      const nextWorkflow: Record<string, string> = {
        purchase_authorized: "approved",
        disbursed: "disbursed",
        repayment_current: "repaying",
        repayment_late: "repaying",
        repayment_completed: "completed",
        cancelled: "cancelled",
      };

      await sql.query(
        `insert into financing_servicing_updates(id,case_id,organization_id,update_type,provider_reference,effective_at,recorded_by_user_id,idempotency_key) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [`fsu_${crypto.randomUUID()}`, data.caseId, access.organizationId, data.updateType, data.providerReference ?? null, data.effectiveAt, userId, data.idempotencyKey],
      );

      if (c.audience === "customer" && ["purchase_authorized", "disbursed", "repayment_completed", "cancelled"].includes(data.updateType)) {
        await sql.query(
          `update customer_financing_applications set intent_closed_at=coalesce(intent_closed_at,$2::timestamptz),updated_at=now() where id=$1`,
          [c.applicationId, data.effectiveAt],
        );
      }
      if (c.audience === "merchant" && ["repayment_completed", "cancelled"].includes(data.updateType)) {
        await sql.query(
          `update merchant_financing_applications set exposure_closed_at=coalesce(exposure_closed_at,$2::timestamptz),updated_at=now() where id=$1`,
          [c.applicationId, data.effectiveAt],
        );
      }

      await sql.query(
        `update financing_application_cases set workflow_status=$2,last_activity_at=now(),updated_at=now(),version=version+1 where id=$1`,
        [c.id, nextWorkflow[data.updateType]],
      );
      await sql.query(
        `insert into financing_case_events(id,case_id,organization_id,actor_user_id,event_type,metadata) values($1,$2,$3,$4,'servicing_update',$5::jsonb)`,
        [`fce_${crypto.randomUUID()}`, c.id, access.organizationId, userId, JSON.stringify({ updateType: data.updateType })],
      );
      await sql.query(
        `insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'financing.servicing_update','financing_case',$3,'success',$4::jsonb)`,
        [access.organizationId, userId, c.id, JSON.stringify({ updateType: data.updateType })],
      );
      return { recorded: true, replayed: false };
    });
  });


export const loadFinancingApplicationFormSubmission=createServerFn({method:"GET"})
  .middleware([authMiddleware])
  .validator(z.object({applicationId:z.string().min(1).max(128)}))
  .handler(async({data,context})=>{
    const userId=getAuthenticatedUserId(context);
    const access=await requirePartnerAccess(userId,"customer_financing");
    const sql=await getSql();
    const submission=await sql.query<any>(`select s.id,s.application_id as "applicationId",s.form_id as "formId",s.form_version as "formVersion",s.submitted_at::text as "submittedAt",f.title
      from financing_application_form_submissions s
      join financing_providers p on p.id=s.provider_id and p.partner_organization_id=$2
      join financing_provider_forms f on f.id=s.form_id
      where s.application_id=$1 limit 1`,[data.applicationId,access.organizationId]);
    if(!submission[0])return null;
    const answers=await sql.query<any>(`select a.id,a.field_key as "fieldKey",a.field_type as "fieldType",a.answer_text as "answerText",
      a.storage_reference as "storageReference",a.content_type as "contentType",f.label
      from financing_application_form_answers a
      join financing_provider_form_fields f on f.id=a.field_id
      where a.submission_id=$1 order by f.sort_order,f.id`,[submission[0].id]);
    const [{ getStorageProvider }, { decryptFinancingSensitiveData }]=await Promise.all([
      import("@/lib/storage/registry.server"),
      import("@/lib/security/financing-sensitive.server"),
    ]);
    const storage=getStorageProvider();
    const safe=[];
    for(const answer of answers){
      let downloadUrl:null|string=null;
      let expiresAt:null|string=null;
      if(answer.storageReference){
        const signed=await storage.createPresignedDownload({key:answer.storageReference,expiresInSeconds:300});
        downloadUrl=signed.downloadUrl;expiresAt=signed.expiresAt;
      }
      safe.push({fieldKey:answer.fieldKey,fieldType:answer.fieldType,label:answer.label,answerText:answer.answerText?decryptFinancingSensitiveData<string>(answer.answerText):null,downloadUrl,downloadExpiresAt:expiresAt,contentType:answer.contentType});
    }
    await sql.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'financing.application_form.viewed','customer_financing_application',$3,'success',$4::jsonb)`,[access.organizationId,userId,data.applicationId,JSON.stringify({submissionId:submission[0].id})]);
    return {...submission[0],answers:safe};
  });
