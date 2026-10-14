import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { withTransaction, getSql } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireAdminForUserId } from "@/modules/identity/public/auth/authorization.server";
import { ADMIN_CAPABILITIES, canDelegatedAdminManageRoles } from "@/modules/identity/public/auth/admin-permission-policy.mjs";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { getPortalConfiguration } from "@/lib/security/portal-policy.mjs";

export const loadAdminStaff = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(async ({ context }) => {
  await requireAdminForUserId(getAuthenticatedUserId(context), "admin.staff.directory");
  const sql = await getSql();
  return sql.query<{ userId: string; name: string; email: string; staffRole: string | null; extraRoles: string[]; status: string | null; twoFactorEnabled: boolean }>(
    `select u.id as "userId", u.name, u.email, s.staff_role as "staffRole", s.status,
            coalesce((select array_agg(e.role_key order by e.role_key)
                from admin_staff_extra_roles e where e.user_id=u.id),'{}') as "extraRoles",
            coalesce(u."twoFactorEnabled",false) as "twoFactorEnabled"
       from "user" u left join admin_staff_roles s on s.user_id=u.id
      where u.role='admin' order by u."createdAt" desc limit 150`,
  );
});

/** Exact verified-email lookup also supports controlled staff onboarding.
 * Looking up a non-administrator requires staff-management authority and a
 * fresh privileged session; rate limits and exact matching prevent bulk search. */
export const findAdminStaffByEmail = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ email: z.string().trim().email().max(254) }))
  .handler(async ({ data, context }) => {
    const actorId = getAuthenticatedUserId(context);
    await requireAdminForUserId(actorId, "admin.staff.directory");
    await enforceRateLimit("admin-staff-lookup", {windowSeconds:60,maxRequests:10,subject:actorId});
    const { getAdminCapabilitiesForUserId } = await import("@/modules/identity/public/auth/authorization.server");
    const capabilities = await getAdminCapabilitiesForUserId(actorId);
    const mayProvision = capabilities.includes("admin.full") || capabilities.includes("admin.staff.manage");
    // Role-restricted HR lookup is performed only for approved staff managers.
    const sql = await getSql();
    const rows = await sql.query<{userId:string;name:string;email:string;staffRole:string|null;extraRoles:string[];status:string|null;twoFactorEnabled:boolean}>(
      `select u.id as "userId",u.name,u.email,s.staff_role as "staffRole",s.status,
              coalesce((select array_agg(e.role_key order by e.role_key)
                  from admin_staff_extra_roles e where e.user_id=u.id),'{}') as "extraRoles",
              coalesce(u."twoFactorEnabled",false) as "twoFactorEnabled"
         from "user" u left join admin_staff_roles s on s.user_id=u.id
        where (u.role='admin' or ($2::boolean and u.role='customer' and u."emailVerified"=true))
          and lower(u.email)=lower($1) limit 1`,
      [data.email,mayProvision],
    );
    return rows[0] ?? null;
  });

const grantSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  staffRole: z.string().regex(/^[a-z][a-z0-9_]{2,48}$/),
  extraRoles: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,48}$/)).max(12).optional(),
  status: z.enum(["active", "suspended"]),
  reason: z.string().trim().min(12).max(1000),
});

export const updateAdminStaff = createServerFn({ method: "POST" })
  .middleware([authMiddleware]).validator(grantSchema).handler(async ({ data, context }) => {
    const actorId = getAuthenticatedUserId(context);
    await requireAdminForUserId(actorId, "admin.staff.manage"); // explicitly delegated HR/admin managers permitted
    await requireFreshSession();
    await enforceRateLimit("admin-staff-grant", {windowSeconds:3600,maxRequests:15,subject:actorId});
    if (data.userId === actorId) throw new Error("Administrators cannot change their own privileges");
    if (data.staffRole === "owner" && data.status !== "active") throw new Error("Owner role must be active");
    if (data.extraRoles?.includes("owner") || data.extraRoles?.includes(data.staffRole) ||
        (data.extraRoles && new Set(data.extraRoles).size !== data.extraRoles.length)) {
      throw new Error("Duplicate, overlapping, or privileged secondary roles are forbidden");
    }
    return withTransaction(async (sql) => {
      // Lock the grant table to serialize two-owner changes; last-owner invariant.
      await sql.query(`lock table admin_staff_roles in share row exclusive mode`);
      // Revocation takes effect even for a concurrent request that passed
      // the pre-transaction gate before this lock was acquired.
      const activeActor = await sql.query<{staff_role:string;status:string}>(
        `select staff_role,status from admin_staff_roles where user_id=$1 for update`, [actorId],
      );
      if (activeActor[0]?.status !== "active") throw new Error("Staff-management permission was suspended");
      const actorIsOwner = activeActor[0]?.staff_role === "owner";
      const actorPermissions = actorIsOwner ? [] : await sql.query<{ capability: string }>(
        `select distinct p.capability from admin_role_permissions p where p.role_key in (
          select staff_role from admin_staff_roles where user_id=$1 and status='active'
          union select role_key from admin_staff_extra_roles where user_id=$1
        )`, [actorId]);
      const actorGrants = new Set(actorPermissions.map(x=>x.capability));
      if (!actorIsOwner && !actorGrants.has('admin.staff.manage')) {
        throw new Error("Staff-management permission revoked while request was pending");
      }
      const users = await sql.query<{id:string;role:string;emailVerified:boolean}>(
        `select id,role,"emailVerified" as "emailVerified"
         from "user" where id=$1 for update`, [data.userId],
      );
      if (users[0]?.role !== "admin" && users[0]?.role !== "customer")
        throw new Error("Only existing customer or administrator accounts may receive staff access");
      if (!users[0].emailVerified) throw new Error("Staff must verify their email before provisioning. 2FA is mandatory for console access.");
      // Never silently convert a merchant into an administrator. Marketplace
      // merchant access is a separate ownership context and must be preserved.
      if (users[0].role === "customer") {
        const memberships = await sql.query<{id:string}>(
          `select merchant_id as id from merchant_accounts where user_id=$1 and status='active' limit 1`, [data.userId]);
        if (memberships.length) throw new Error("Active merchant identities cannot be repurposed as employees");
      }
      const assignedRole = await sql.query<{ role_key: string }>(
        `select role_key from admin_roles where role_key=$1 limit 1`, [data.staffRole],
      );
      if (!assignedRole[0]) throw new Error("Unknown staff role; create the role before assigning it");
      const previousExtras = await sql.query<{role_key:string}>(
        `select role_key from admin_staff_extra_roles where user_id=$1 order by role_key`,[data.userId]);
      const nextExtras = data.extraRoles ?? previousExtras.map(r=>r.role_key);
      if (nextExtras.includes('owner') || nextExtras.includes(data.staffRole) ||
          new Set(nextExtras).size !== nextExtras.length) throw new Error('Invalid additional role assignment');
      const nextRoles = [data.staffRole,...nextExtras];
      const verifiedRoles = await sql.query<{role_key:string}>(
        `select role_key from admin_roles where role_key=any($1::text[])`,[nextRoles]);
      if (verifiedRoles.length !== nextRoles.length) throw new Error('Unknown additional staff role');
      // A bound executive cannot be removed/reassigned through ordinary staff HR.
      // Dedicated owner transfer requires an independent audited recovery procedure.
      const portals = getPortalConfiguration();
      if (portals && data.userId === portals.executiveUserId) {
        throw new Error("Configured executive identity cannot be suspended or demoted");
      }
      if (portals && data.staffRole === "owner" && data.userId !== portals.executiveUserId) {
        throw new Error("Only the configured executive may hold a new owner grant while portal separation is active");
      }
      const previous = await sql.query<{staff_role:string;status:string}>(
        `select staff_role,status from admin_staff_roles where user_id=$1 for update`, [data.userId],
      );
      if (!actorIsOwner) {
        if (data.staffRole === 'owner' || previous[0]?.staff_role === 'owner') {
          throw new Error('Only a Main Administrator can grant or change Main Administrator rights');
        }
        const oldRoles = [previous[0]?.staff_role,...previousExtras.map(r=>r.role_key)].filter(Boolean);
        const affectedPermissions = await sql.query<{capability:string}>(
          `select distinct capability from admin_role_permissions
            where role_key=any($1::text[]) or role_key=any($2::text[])`,
          [oldRoles,nextRoles]);
        if (!canDelegatedAdminManageRoles({ actorOwner: false,
             actorCapabilities:[...actorGrants],
             oldCapabilities:affectedPermissions.map(p=>p.capability),
             nextCapabilities:[], oldPrimaryRole:previous[0]?.staff_role ?? null,
             nextPrimaryRole:data.staffRole })) {
          throw new Error('Cannot assign or modify roles with privileges outside your own authority');
        }
      }
      // A second owner may revoke a compromised owner's access, but the
      // final active owner must survive. This check runs under a table lock.
      if (previous[0]?.staff_role === "owner" && previous[0].status === "active" &&
          (data.staffRole !== "owner" || data.status !== "active")) {
        const others = await sql.query<{count:number}>(
          `select count(*)::int as count from admin_staff_roles
           where staff_role='owner' and status='active' and user_id<>$1`, [data.userId],
        );
        if (!others[0]?.count) throw new Error("Cannot revoke the last active administrator owner");
      }
      // Both identity promotion and the staff grant happen in the SAME
      // transaction, with the recorded audit decision. Failed grants roll back.
      if (users[0].role === "customer") {
        await sql.query(`update "user" set role='admin',"updatedAt"=now() where id=$1 and role='customer'`, [data.userId]);
        // Existing customer sessions must never become privileged sessions.
        await sql.query(`delete from "session" where "userId"=$1`, [data.userId]);
      }
      await sql.query(
        `insert into admin_staff_roles(user_id,staff_role,status,assigned_by,assigned_reason,assigned_at,updated_at)
         values($1,$2,$3,$4,$5,now(),now()) on conflict(user_id) do update
         set staff_role=excluded.staff_role,status=excluded.status,assigned_by=excluded.assigned_by,
             assigned_reason=excluded.assigned_reason,assigned_at=now(),updated_at=now()`,
        [data.userId,data.staffRole,data.status,actorId,data.reason],
      );
      if (data.extraRoles !== undefined) {
        await sql.query(`delete from admin_staff_extra_roles where user_id=$1`,[data.userId]);
        for (const roleKey of nextExtras) {
          await sql.query(`insert into admin_staff_extra_roles(user_id,role_key,assigned_by,assigned_reason)
              values($1,$2,$3,$4)`,[data.userId,roleKey,actorId,data.reason]);
        }
      }
      await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
        "admin.staff.role_changed","admin_staff_role",data.userId,actorId,"admin",null,"success",
        JSON.stringify({provisionedFromCustomer:users[0].role === "customer",fromRole:previous[0]?.staff_role??null,fromStatus:previous[0]?.status??null,
          fromExtraRoles:previousExtras.map(r=>r.role_key),toExtraRoles:nextExtras,
          toRole:data.staffRole,toStatus:data.status,reason:data.reason}),
      ]);
      return { saved: true };
    });
  });

/** Read the company role catalogue; only a main admin may edit role definitions. */
export const loadAdminRoles = createServerFn({ method: "GET" })
  .middleware([authMiddleware]).handler(async ({ context }) => {
    await requireAdminForUserId(getAuthenticatedUserId(context), "admin.staff.directory");
    const sql = await getSql();
    const roles = await sql.query<{ roleKey: string; displayName: string; description: string; systemRole: boolean; permissions: string[] }>(
      `select r.role_key as "roleKey",r.display_name as "displayName",
              r.description,r.system_role as "systemRole",
              coalesce(array_agg(p.capability order by p.capability)
                filter(where p.capability is not null),'{}') as permissions
         from admin_roles r left join admin_role_permissions p on p.role_key=r.role_key
        group by r.role_key order by r.system_role desc,r.display_name`,
    );
    return { roles, availablePermissions: [...ADMIN_CAPABILITIES] };
  });

const roleSchema = z.object({
  roleKey: z.string().regex(/^[a-z][a-z0-9_]{2,48}$/),
  displayName: z.string().trim().min(3).max(80),
  description: z.string().trim().max(500),
  permissions: z.array(z.string()).max(32),
  reason: z.string().trim().min(12).max(1000),
});

export const saveAdminRole = createServerFn({ method: "POST" })
  .middleware([authMiddleware]).validator(roleSchema).handler(async ({ data, context }) => {
    const actorId = getAuthenticatedUserId(context);
    await requireAdminForUserId(actorId); // Main Admin only; cannot delegate role-authoring power.
    await requireFreshSession();
    await enforceRateLimit("admin-role-update", { windowSeconds: 3600, maxRequests: 25, subject: actorId });
    if (data.roleKey === "owner") throw new Error("Main Administrator privileges cannot be edited");
    if (new Set(data.permissions).size !== data.permissions.length ||
        data.permissions.some((permission) => !ADMIN_CAPABILITIES.includes(permission as typeof ADMIN_CAPABILITIES[number]))) {
      throw new Error("Unknown or duplicate permission requested");
    }
    return withTransaction(async (sql) => {
      // Revalidate actor inside the role-change transaction: an old session
      // must not continue to edit roles after the Main Admin grant is revoked.
      await sql.query(`lock table admin_staff_roles in share row exclusive mode`);
      const actor = await sql.query<{ staff_role: string; status: string }>(
        `select staff_role,status from admin_staff_roles where user_id=$1 for update`, [actorId]);
      if (actor[0]?.staff_role !== "owner" || actor[0]?.status !== "active") {
        throw new Error("Main Administrator authority has been revoked");
      }
      const previous = await sql.query<{ display_name: string }>(
        `select display_name from admin_roles where role_key=$1 for update`, [data.roleKey],
      );
      const oldPermissions = await sql.query<{ capability: string }>(
        `select capability from admin_role_permissions where role_key=$1`, [data.roleKey]);
      await sql.query(
        `insert into admin_roles(role_key,display_name,description,created_by)
         values($1,$2,$3,$4) on conflict (role_key) do update
         set display_name=excluded.display_name,description=excluded.description,updated_at=now()`,
        [data.roleKey,data.displayName,data.description,actorId]);
      await sql.query(`delete from admin_role_permissions where role_key=$1`, [data.roleKey]);
      for (const permission of data.permissions) {
        await sql.query(`insert into admin_role_permissions(role_key,capability) values($1,$2)`, [data.roleKey,permission]);
      }
      await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
        "admin.role.permissions_changed", "admin_role", data.roleKey, actorId, "admin", null, "success",
        JSON.stringify({ oldName: previous[0]?.display_name ?? null,
          oldPermissions: oldPermissions.map((r) => r.capability), permissions: data.permissions,
          newName: data.displayName, reason: data.reason }),
      ]);
      return { saved: true };
    });
  });
