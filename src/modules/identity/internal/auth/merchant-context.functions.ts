import { createServerFn } from "@tanstack/react-start";
import { authMiddleware, getAuthenticatedUserId } from "./middleware";

export type MerchantLoginContext =
  | { authorized: true; merchantIds: string[] }
  | {
      authorized: false;
      reason: "not_found" | "pending" | "rejected" | "not_activated" | "suspended" | "admin_only";
    };

/**
 * Establishes merchant login context independently of the customer's login
 * destination. A user may have both a customer identity and one or more
 * active merchant memberships; the database membership, not user.role alone,
 * is the source of truth for merchant access. This read-only context must
 * not expire with the high-risk mutation freshness window; otherwise the
 * merchant navigation link disappears after normal session aging.
 */
export const getMerchantLoginContext = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const userId = getAuthenticatedUserId(context);

    const { getSql } = await import("../../../../lib/db");
    const sql = await getSql();
    const user = await sql.query<{ role: string }>(
      `select role from "user" where id=$1 limit 1`,
      [userId],
    );
    if (!user[0]) throw new Error("Account not found");
    if (user[0].role === "admin") return { authorized: false as const, reason: "admin_only" as const };

    const active = await sql.query<{ merchant_id: string }>(
      `select merchant_id
         from merchant_accounts
        where user_id=$1 and status='active'
        order by created_at asc`,
      [userId],
    );
    if (active.length > 0) {
      return { authorized: true as const, merchantIds: active.map((row) => row.merchant_id) };
    }

    const suspended = await sql.query<{ n: number }>(
      `select count(*)::int as n from merchant_accounts where user_id=$1 and status in ('suspended','revoked')`,
      [userId],
    );
    if ((suspended[0]?.n ?? 0) > 0) {
      return { authorized: false as const, reason: "suspended" as const };
    }

    const application = await sql.query<{ status: string }>(
      `select status
         from merchant_applications
        where user_id=$1
        order by created_at desc
        limit 1`,
      [userId],
    );
    const status = application[0]?.status;
    if (status === "pending" || status === "reviewing") {
      return { authorized: false as const, reason: "pending" as const };
    }
    if (status === "rejected") {
      return { authorized: false as const, reason: "rejected" as const };
    }
    if (status === "approved") {
      return { authorized: false as const, reason: "not_activated" as const };
    }

    return { authorized: false as const, reason: "not_found" as const };
  });
