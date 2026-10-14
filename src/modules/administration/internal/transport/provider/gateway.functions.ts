import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { getSql, withTransaction } from "@/lib/db";
import { assertPortalOperationHost } from "@/lib/security/portal-access.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const capability = z.enum(["delivery","customer_financing","merchant_financing"]);
const applicationSchema = z.object({
  organizationName: z.string().trim().min(2).max(160),
  contactPhone: z.string().trim().min(6).max(40).optional(),
  websiteUrl: z.string().url().max(500).refine((v)=>v.startsWith("https://"),"HTTPS website required").optional(),
  requestedCapabilities: z.array(capability).min(1).max(3).refine((v)=>new Set(v).size===v.length,"Duplicate provider capability"),
  processingMode: z.enum(["manual","hybrid","api"]).default("manual"),
  serviceDescription: z.string().trim().min(10).max(3000),
});

export const submitProviderApplication = createServerFn({ method:"POST" })
  .middleware([authMiddleware])
  .validator(applicationSchema)
  .handler(async ({ data, context }) => {
    assertPortalOperationHost("provider");
    const userId=getAuthenticatedUserId(context);
    await enforceRateLimit("provider-application-submit",{windowSeconds:3600,maxRequests:3,subject:userId});
    return withTransaction(async (sql)=>{
      await sql.query(`select pg_advisory_xact_lock(hashtext($1))`,[`elemarket:provider-application:${userId}`]);
      const user=await sql.query<{email:string;emailVerified:boolean}>(`select email,"emailVerified" from "user" where id=$1 limit 1`,[userId]);
      if(!user[0]?.email || user[0].emailVerified !== true) throw new Error("Verify your account email before applying as a provider");
      const active=await sql.query<{id:string;status:string}>(
        `select id,status from provider_gateway_applications where applicant_user_id=$1 and status in ('review','information_requested','approved') order by created_at desc limit 1 for update`,
        [userId],
      );
      if(active.length) return {applicationId:active[0].id,status:active[0].status,replayed:true};
      const id=`pga_${crypto.randomUUID().replaceAll("-","")}`;
      await sql.query(
        `insert into provider_gateway_applications(id,applicant_user_id,organization_name,contact_email,contact_phone,website_url,requested_capabilities,processing_mode,service_description)
         values($1,$2,$3,$4,$5,$6,$7::text[],$8,$9)`,
        [id,userId,data.organizationName,user[0].email,data.contactPhone??null,data.websiteUrl??null,data.requestedCapabilities,data.processingMode,data.serviceDescription],
      );
      return {applicationId:id,status:"review",replayed:false};
    });
  });

export const getProviderGatewayContext = createServerFn({ method:"GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    assertPortalOperationHost("provider");
    const userId=getAuthenticatedUserId(context);
    const sql=await getSql();
    const memberships=await sql.query<{organizationId:string;organizationName:string;role:string;status:string;capabilities:string[]}>(
      `select o.id as "organizationId",o.name as "organizationName",u.role,u.status,
              coalesce(array_agg(c.capability order by c.capability) filter(where c.capability is not null),'{}') as capabilities
         from partner_organization_users u
         join partner_organizations o on o.id=u.organization_id and o.status='active'
         left join partner_organization_capabilities c on c.organization_id=o.id
        where u.user_id=$1 and u.status='active'
        group by o.id,o.name,u.role,u.status
        order by o.id`,
      [userId],
    );
    if(memberships.length>1) throw new Error("Multiple provider organizations require administrator resolution");
    if(memberships.length===1) return {authorized:true as const,...memberships[0]};
    const blocked=await sql.query<{organizationName:string;organizationStatus:string;membershipStatus:string}>(
      `select o.name as "organizationName",o.status as "organizationStatus",u.status as "membershipStatus"
         from partner_organization_users u join partner_organizations o on o.id=u.organization_id
        where u.user_id=$1 order by u.created_at desc limit 1`,
      [userId],
    );
    if(blocked.length) return {authorized:false as const,blocked:blocked[0],application:null};
    const applications=await sql.query<{id:string;organizationName:string;status:string;processingMode:string;requestedCapabilities:string[];adminNote:string|null;createdAt:string}>(
      `select id,organization_name as "organizationName",status,processing_mode as "processingMode",
              requested_capabilities as "requestedCapabilities",admin_note as "adminNote",created_at::text as "createdAt"
         from provider_gateway_applications where applicant_user_id=$1 order by created_at desc limit 1`,
      [userId],
    );
    return {authorized:false as const,application:applications[0]??null};
  });
