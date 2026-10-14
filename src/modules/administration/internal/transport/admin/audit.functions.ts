import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const querySchema = z.object({beforeId:z.string().regex(/^[1-9]\d{0,18}$/).optional()});
export type AdminActivityRow = {
  id:string; eventType:string; resourceType:string; resourceId:string|null;
  actorId:string|null; actorRole:string|null; outcome:string; createdAt:string;
};
/** Read-only, owner-gated activity feed; intentionally omits metadata/PII. */
export const loadAdminAuditHistory = createServerFn({method:"GET"})
  .middleware([authMiddleware]).validator(querySchema).handler(async({data,context})=>{
    const actorId=getAuthenticatedUserId(context);
    await requireAdminForUserId(actorId, "admin.audit.read");
    await enforceRateLimit("admin-audit-history",{windowSeconds:60,maxRequests:30,subject:actorId});
    const sql=await getSql();
    return sql.query<AdminActivityRow>(
      `select id::text as id,event_type as "eventType",resource_type as "resourceType",resource_id as "resourceId",
              actor_user_id as "actorId",actor_role as "actorRole",outcome,
              to_char(created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as "createdAt"
         from audit_events where ($1::bigint is null or id<$1::bigint)
        order by id desc limit 100`, [data.beforeId??null]);
  });
