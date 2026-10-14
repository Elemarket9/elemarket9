import { requireUserId } from "./verify.server";
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "./server";
import { canGrantedAdminPerform, expandAdminCapabilities } from "./admin-permission-policy.mjs";
import { assertPortalOperationHost, assertAdminPortalPrincipal } from "../../../../lib/security/portal-access.server";

export type AppRole = "customer" | "merchant" | "admin";

/**
 * Server-only authorization helpers.
 *
 * Authentication answers "who is this?"; authorization answers "what may they
 * do?". Never accept a role or ownership decision from request JSON, query
 * parameters, localStorage, or client state.
 */
async function loadRole(userId: string): Promise<AppRole> {
  const { getSql } = await import("../../../../lib/db");
  const sql = await getSql();
  const rows = await sql.query<{ role: AppRole }>(
    `select role from "user" where id = $1 limit 1`,
    [userId],
  );
  const role = rows[0]?.role;
  if (role === "customer") {
    const moderation = await sql.query<{ moderationStatus: string }>(
      `select "moderationStatus" from "user" where id = $1 limit 1`,
      [userId],
    );
    if (moderation[0]?.moderationStatus === "blacklisted") throw new Error("Account is blacklisted");
  }
  if (role !== "customer" && role !== "merchant" && role !== "admin") {
    throw new Error("Forbidden");
  }
  return role;
}

export async function requireRoleForUserId(
  allowed: readonly AppRole[],
  userId: string,
): Promise<{ userId: string; role: AppRole }> {
  const role = await loadRole(userId);
  if (!allowed.includes(role)) throw new Error("Forbidden");
  if (role === "admin") {
    await assertAdminSessionAssurance(userId);
    // A role flag alone is not an administrator grant. No default permission.
    const staffRole = await getAdminStaffRole(userId);
    if (!staffRole) throw new Error("Forbidden: administrator not provisioned");
    assertAdminPortalPrincipal(staffRole, userId);
    // Staff cannot borrow the administrator role to bypass merchant/customer
    // ownership policy in cross-domain APIs. Owner is the only exception.
    if (staffRole !== "owner" && allowed.some((allowedRole) => allowedRole !== "admin")) {
      throw new Error("Forbidden: administrator cross-role access");
    }
  }
  return { userId, role };
}

export async function getCurrentRole(bearerToken?: string): Promise<AppRole> {
  return loadRole(await requireUserId(bearerToken));
}

export async function requireRole(
  allowed: readonly AppRole[],
  bearerToken?: string,
): Promise<{ userId: string; role: AppRole }> {
  return requireRoleForUserId(allowed, await requireUserId(bearerToken));
}

export async function requireCustomer(bearerToken?: string) {
  return requireRole(["customer"], bearerToken);
}

export async function requireCustomerForUserId(userId: string) {
  return requireRoleForUserId(["customer"], userId);
}

export async function requireCustomerOrAdmin(bearerToken?: string) {
  return requireRole(["customer", "admin"], bearerToken);
}

export async function requireCustomerOrAdminForUserId(userId: string) {
  return requireRoleForUserId(["customer", "admin"], userId);
}

export async function requireAdmin(bearerToken?: string) {
  return requireAdminForUserId(await requireUserId(bearerToken));
}

export type AdminStaffRole = string;
export type AdminCapability =
  | "admin.full" | "admin.operations" | "admin.support"
  | "admin.merchants.review" | "admin.merchants.moderate"
  | "admin.customers.moderate" | "admin.products.moderate" | "admin.categories.manage"
  | "admin.enterprise.manage" | "admin.providers.manage" | "admin.financing.manage"
  | "admin.campaigns.manage" | "admin.audit.read" | "admin.staff.directory"
  | "admin.finance.refunds" | "admin.finance.policy" | "admin.finance.view"
  | "admin.staff.manage";


export async function getAdminStaffRole(userId: string): Promise<AdminStaffRole | null> {
  const { getSql } = await import("../../../../lib/db");
  const sql = await getSql();
  const rows = await sql.query<{ staff_role: string }>(
    `select a.staff_role from admin_staff_roles a join "user" u on u.id=a.user_id
     where a.user_id=$1 and a.status='active' and u.role='admin' limit 1`,
    [userId],
  );
  const role = rows[0]?.staff_role;
  return role ?? null;
}

/** All legacy admin endpoints default to OWNER ONLY. Delegation is explicit. */
export async function requireAdminForUserId(userId: string, capability: AdminCapability = "admin.full") {
  const principal = await requireRoleForUserId(["admin"], userId);
  const staffRole = await getAdminStaffRole(userId);
  if (!staffRole) throw new Error("Forbidden: administrator permission required");
  const { getSql } = await import("../../../../lib/db");
  const sql = await getSql();
  const grants = await sql.query<{ capability: AdminCapability }>(
    `select distinct p.capability from admin_role_permissions p
        where p.role_key = $1 or p.role_key in (
          select x.role_key from admin_staff_extra_roles x
          join admin_staff_roles s on s.user_id=x.user_id
          where x.user_id=$2 and s.status='active'
        )`, [staffRole,userId],
  );
  if (!canGrantedAdminPerform(staffRole, grants.map((row) => row.capability), capability)) {
    throw new Error("Forbidden: administrator permission required");
  }
  return principal;
}

/** Read checked effective privileges for scoping mixed admin workspaces. */
export async function getAdminCapabilitiesForUserId(userId: string): Promise<AdminCapability[]> {
  await requireRoleForUserId(["admin"], userId);
  const role = await getAdminStaffRole(userId);
  if (!role) throw new Error("Forbidden: administrator not provisioned");
  if (role === "owner") return ["admin.full"];
  const { getSql } = await import("../../../../lib/db");
  const sql = await getSql();
  const rows = await sql.query<{capability:AdminCapability}>(
    `select distinct p.capability from admin_role_permissions p where p.role_key in (
        select staff_role from admin_staff_roles where user_id=$1 and status='active'
        union select role_key from admin_staff_extra_roles where user_id=$1
      )`,[userId]);
  return expandAdminCapabilities(rows.map(row=>row.capability)) as AdminCapability[];
}

export async function requireAdminRoleForUserId(userId: string) {
  return requireAdminForUserId(userId);
}

async function assertAdminSessionAssurance(userId: string): Promise<void> {
  const request = getRequest();
  if (!request) throw new Error("Administrator authentication assurance is required");

  // Use Better Auth's canonical request-session resolution instead of parsing
  // the session cookie ourselves. This keeps the authorization check aligned
  // with the same cookie/session semantics used by getSessionUser(), including
  // cookie prefixes, secure-cookie handling, and any future Better Auth changes.
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user || session.user.id !== userId || !session.session) {
    throw new Error("Administrator authentication assurance is required");
  }

  const { getSql } = await import("../../../../lib/db");
  const sql = await getSql();
  const rows = await sql.query<{ enabled: boolean; enabled_at: string | null }>(
    `select coalesce("twoFactorEnabled", false) as enabled, "twoFactorEnabledAt" as enabled_at
       from "user" where id=$1 limit 1`,
    [userId],
  );
  if (!rows[0]?.enabled) throw new Error("Administrator two-factor authentication is required");

  const createdAt = Date.parse(String(session.session.createdAt));
  const enabledAt = rows[0].enabled_at ? Date.parse(rows[0].enabled_at) : NaN;
  if (!Number.isFinite(createdAt) || (Number.isFinite(enabledAt) && createdAt < enabledAt)) {
    throw new Error("Administrator session predates required two-factor authentication");
  }

  // A facial-authenticated session is an explicitly lower-assurance method:
  // recheck its live server-side profile on EVERY privileged request. A
  // simultaneous shutdown/revocation must not be bypassed by a late session
  // mint, and no face session may outlive production's biometric safety gate.
  const assurance = await sql.query<{method:string;enabled:boolean;locked_until:string|null}>(
    `select a.method, coalesce(p.enabled,false) as enabled, p.locked_until
       from executive_face_session_assurance a
       left join executive_face_profiles p on p.user_id=a.user_id
      where a.session_id=$1 and a.user_id=$2 limit 1`,
    [session.session.id,userId],
  );
  if (assurance[0]?.method?.startsWith('face-passphrase')) {
    const {faceEngineConfigured} = await import('./executive/engine.server.mjs');
    if (!faceEngineConfigured() || !assurance[0].enabled ||
        (assurance[0].locked_until && Date.parse(String(assurance[0].locked_until)) > Date.now())) {
      throw new Error('Executive biometric session revoked or unavailable');
    }
  }
}

export async function requireMerchantOrAdmin(bearerToken?: string) {
  return requireRole(["merchant", "admin"], bearerToken);
}

/**
 * Merchant workspace authorization. A user may remain a customer at the base
 * identity level while gaining merchant access through an active merchant
 * membership. Admins are always permitted to enter the merchant context.
 */
export async function requireMerchantOrAdminForUserId(userId: string): Promise<{ userId: string; role: AppRole }> {
  const principal = await requireRoleForUserId(["customer", "merchant", "admin"], userId);
  if (principal.role !== "admin") assertPortalOperationHost("seller");
  if (principal.role === "admin" || principal.role === "merchant") return principal;

  const { getSql } = await import("../../../../lib/db");
  const sql = await getSql();
  const rows = await sql.query<{ merchant_id: string }>(
    `select merchant_id
       from merchant_accounts
      where user_id=$1 and status='active'
      limit 1`,
    [userId],
  );
  if (!rows[0]) throw new Error("Merchant access denied");
  return { userId, role: "merchant" };
}

/**
 * Proves that the authenticated principal may operate on this merchant.
 * Admins may operate across merchants; merchants may operate only on accounts
 * explicitly linked to their verified session identity.
 */
export async function requireMerchantWorkspaceForUserId(
  userId: string,
): Promise<{ userId: string; role: AppRole; merchantIds: string[] }> {
  const principal = await requireRoleForUserId(["customer", "merchant", "admin"], userId);
  if (principal.role !== "admin") assertPortalOperationHost("seller");
  const { getSql } = await import("../../../../lib/db");
  const sql = await getSql();
  const rows = await sql.query<{ merchant_id: string }>(
    `select merchant_id
       from merchant_accounts
      where user_id = $1 and status = 'active'
      order by created_at asc`,
    [userId],
  );
  if (rows.length === 0) throw new Error("Merchant access denied");
  return { ...principal, merchantIds: rows.map((row) => row.merchant_id) };
}

export async function requireMerchantAccessForUserId(
  merchantId: string,
  userId: string,
): Promise<{ userId: string; role: AppRole }> {
  const principal = await requireRoleForUserId(["customer", "merchant", "admin"], userId);
  if (principal.role === "admin") return principal;
  assertPortalOperationHost("seller");

  const { getSql } = await import("../../../../lib/db");
  const sql = await getSql();
  const rows = await sql.query<{ merchant_id: string }>(
    `select merchant_id
       from merchant_accounts
      where merchant_id = $1
        and user_id = $2
        and status = 'active'
      limit 1`,
    [merchantId, principal.userId],
  );
  if (!rows[0]) throw new Error("Merchant access denied");
  return principal;
}

export async function requireMerchantAccess(
  merchantId: string,
  bearerToken?: string,
): Promise<{ userId: string; role: AppRole }> {
  return requireMerchantAccessForUserId(merchantId, await requireUserId(bearerToken));
}
