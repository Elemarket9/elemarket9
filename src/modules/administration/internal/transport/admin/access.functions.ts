import { createServerFn } from "@tanstack/react-start";
import { getSessionUser } from "@/modules/identity/public/auth/verify.server";
import { getSql } from "@/lib/db";
import { expandAdminCapabilities } from "@/modules/identity/public/auth/admin-permission-policy.mjs";
import { currentAdminPortalKind, isAdminPortalPrincipal } from "@/lib/security/portal-access.server";

export type AdminAccessState = {
  authenticated: boolean;
  isAdmin: boolean;
  displayName: string | null;
  twoFactorEnabled: boolean;
  staffRole: string | null;
  capabilities: string[];
  assignedRoles: string[];
  portal: "executive" | "staff" | "legacy";
};

/**
 * Read-only admin entry-point check. This intentionally does not use the admin
 * middleware because /admin is also the unauthenticated admin sign-in page.
 * The dashboard and every sensitive admin mutation still enforce authorization
 * server-side with requireAdminForUserId().
 */
export const getAdminAccessState = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminAccessState> => {
    const portal = currentAdminPortalKind();
    const user = await getSessionUser();
    if (!user) {
      return { authenticated: false, isAdmin: false, displayName: null, twoFactorEnabled: false, staffRole: null, capabilities: [], assignedRoles: [], portal };
    }

    const sql = await getSql();
    const rows = await sql.query<{ role: string; name: string; twoFactorEnabled: boolean }>(
      `select role, name, coalesce("twoFactorEnabled", false) as "twoFactorEnabled" from "user" where id = $1 limit 1`,
      [user.id],
    );
    const row = rows[0];
    const roles = await sql.query<{ staff_role: string }>(
      `select staff_role from admin_staff_roles where user_id=$1 and status='active' limit 1`, [user.id],
    );
    const grantedRole = row?.role === "admin" ? roles[0]?.staff_role ?? null : null;
    const staffRole = grantedRole && isAdminPortalPrincipal(grantedRole, user.id) ? grantedRole : null;
    const extras = staffRole ? await sql.query<{role_key:string}>(
      `select role_key from admin_staff_extra_roles where user_id=$1 order by role_key`,[user.id],
    ) : [];
    const assignedRoles = staffRole ? [staffRole,...extras.map(r=>r.role_key)] : [];
    const grants = assignedRoles.length ? await sql.query<{ capability: string }>(
      `select distinct capability from admin_role_permissions where role_key=any($1::text[]) order by capability`, [assignedRoles],
    ) : [];
    const capabilities = staffRole === "owner" ? ["admin.full"] : expandAdminCapabilities(grants.map((row) => row.capability));
    return {
      authenticated: true,
      isAdmin: Boolean(staffRole),
      staffRole,
      capabilities,
      assignedRoles,
      portal,
      displayName: row?.name ?? null,
      twoFactorEnabled: Boolean(row?.twoFactorEnabled),
    };
  },
);
