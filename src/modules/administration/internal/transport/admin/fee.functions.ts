import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql, withTransaction } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";

export type AdminCommissionRule = {
  id: number;
  scopeType: "global" | "category" | "merchant" | "product";
  scopeId: string | null;
  ratePercent: string;
  active: boolean;
  updatedAt: string;
};

export type AdminCommissionData = {
  rules: AdminCommissionRule[];
};

export const loadCommissionPolicy = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<AdminCommissionData> => {
    const adminId = getAuthenticatedUserId(context);
    await requireAdminForUserId(adminId, "admin.finance.view");
    const sql = await getSql();
    const rules = await sql.query<{
        id: number;
        scope_type: AdminCommissionRule["scopeType"];
        scope_id: string | null;
        rate_bps: number;
        active: boolean;
        updated_at: string;
      }>(
        `select id,scope_type,scope_id,rate_bps,active,updated_at::text
           from commission_rules
          order by case scope_type when 'global' then 0 when 'category' then 1 when 'merchant' then 2 else 3 end, scope_id nulls first`,
      );
    return {
      rules: rules.map((r) => ({
        id: Number(r.id),
        scopeType: r.scope_type,
        scopeId: r.scope_id,
        ratePercent: (Number(r.rate_bps) / 100).toFixed(2),
        active: Boolean(r.active),
        updatedAt: r.updated_at,
      })),
    };
  });

const ruleSchema = z.object({
  scopeType: z.enum(["global", "category", "merchant", "product"]),
  scopeId: z.string().trim().max(200).optional().nullable(),
  ratePercent: z.number().min(0).max(100),
  active: z.boolean().default(true),
  reason: z.string().trim().min(12).max(1000),
});

const globalRuleSchema = z.object({
  ratePercent: z.number().min(0).max(100),
  active: z.boolean().default(true),
  reason: z.string().trim().min(12).max(1000),
});

export const setGlobalCommissionRule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(globalRuleSchema)
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    await requireAdminForUserId(adminId, "admin.finance.policy");
    await requireFreshSession();
    const rateBps = Math.round(data.ratePercent * 100);
    return withTransaction(async (sql) => {
      // Lock the policy table to serialize concurrent overrides and their audit trails.
      await sql.query(`lock table commission_rules in share row exclusive mode`);
      const before = await sql.query<{rate_bps:number;active:boolean}>(
        `select rate_bps,active from commission_rules where scope_type='global' and scope_id is null limit 1`,
      );
      await sql.query(
        `insert into commission_rules(scope_type,scope_id,rate_bps,active,updated_by,updated_at)
         values('global',null,$1,$2,$3,now())
         on conflict (scope_type,(coalesce(scope_id,'*')))
         do update set rate_bps=excluded.rate_bps,active=excluded.active,updated_by=excluded.updated_by,updated_at=now()`,
        [rateBps, data.active, adminId],
      );
      await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
        "commission_rule_updated", "commission_rule", "global:global", adminId,"admin",null,"success",
        JSON.stringify({scopeType:"global",fromRateBps:before[0]?.rate_bps??null,
          fromActive:before[0]?.active??null,rateBps,active:data.active,reason:data.reason}),
      ]);
      return { ok: true };
    });
  });

export const setCommissionRule = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(ruleSchema)
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    await requireAdminForUserId(adminId, "admin.finance.policy");
    await requireFreshSession();

    const scopeId = data.scopeType === "global" ? null : data.scopeId?.trim() || null;
    if (data.scopeType !== "global" && !scopeId) throw new Error("scopeId is required for an override");

    const rateBps = Math.round(data.ratePercent * 100);
    return withTransaction(async (sql) => {
      await sql.query(`lock table commission_rules in share row exclusive mode`);
      const before = await sql.query<{rate_bps:number;active:boolean}>(
        `select rate_bps,active from commission_rules where scope_type=$1 and scope_id is not distinct from $2`,
        [data.scopeType,scopeId],
      );
      await sql.query(
        `insert into commission_rules(scope_type,scope_id,rate_bps,active,updated_by,updated_at)
         values($1,$2,$3,$4,$5,now())
         on conflict (scope_type,(coalesce(scope_id,'*')))
         do update set rate_bps=excluded.rate_bps,active=excluded.active,updated_by=excluded.updated_by,updated_at=now()`,
        [data.scopeType,scopeId,rateBps,data.active,adminId],
      );
      await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
        "commission_rule_updated","commission_rule",`${data.scopeType}:${scopeId ?? "global"}`,adminId,"admin",null,"success",
        JSON.stringify({scopeType:data.scopeType,scopeId,fromRateBps:before[0]?.rate_bps??null,
          fromActive:before[0]?.active??null,rateBps,active:data.active,reason:data.reason}),
      ]);
      return {ok:true};
    });
  });

const removeRuleSchema = z.object({
  scopeType: z.enum(["category", "merchant", "product"]),
  scopeId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(12).max(1000),
});

export const removeCommissionOverride = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(removeRuleSchema)
  .handler(async ({ data, context }) => {
    const adminId = getAuthenticatedUserId(context);
    await requireAdminForUserId(adminId, "admin.finance.policy");
    await requireFreshSession();
    return withTransaction(async (sql) => {
      await sql.query(`lock table commission_rules in share row exclusive mode`);
      const deleted = await sql.query<{rate_bps:number;active:boolean}>(
        `delete from commission_rules where scope_type=$1 and scope_id=$2 returning rate_bps,active`,
        [data.scopeType,data.scopeId],
      );
      if (!deleted.length) throw new Error("Commission override not found");
      await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
        "commission_rule_removed","commission_rule",`${data.scopeType}:${data.scopeId}`,adminId,"admin",null,"success",
        JSON.stringify({fromRateBps:deleted[0].rate_bps,fromActive:deleted[0].active,reason:data.reason}),
      ]);
      return {ok:true};
    });
  });
