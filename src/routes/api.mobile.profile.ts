import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { auth } from "@/modules/identity/public/auth/server";
import { getSql } from "@/lib/db";
import { enforceRateLimit, rateLimitResponse } from "@/lib/security/rate-limit.server";
import { readBodyWithLimit } from "@/lib/security/body.server";
import { assertSameSiteRequest } from "@/modules/identity/public/auth/isolation.server";

import { ghanaPhoneSchema } from "@/modules/identity/public/auth/phone";

const MAX_PROFILE_BODY_BYTES = 8 * 1024;

const bodySchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: ghanaPhoneSchema.optional().or(z.literal("")),
  address: z.string().trim().min(8).max(400),
});

export const Route = createFileRoute("/api/mobile/profile")({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        assertSameSiteRequest();
        const current = await auth.api.getSession({ headers: request.headers });
        if (!current?.user) {
          return Response.json(
            { error: "Unauthorized" },
            { status: 401, headers: { "cache-control": "no-store" } },
          );
        }

        try {
          await enforceRateLimit("mobile-profile-write", {
            windowSeconds: 60,
            maxRequests: 20,
            subject: current.user.id,
          });
        } catch (error) {
          const limited = rateLimitResponse(error);
          if (limited) return limited;
          throw error;
        }

        let rawBody: string;
        try {
          rawBody = await readBodyWithLimit(request, MAX_PROFILE_BODY_BYTES);
        } catch {
          return Response.json(
            { error: "Request too large" },
            { status: 413, headers: { "cache-control": "no-store" } },
          );
        }

        let data: unknown;
        try {
          data = JSON.parse(rawBody);
        } catch {
          return Response.json(
            { error: "Invalid JSON" },
            { status: 400, headers: { "cache-control": "no-store" } },
          );
        }

        const parsed = bodySchema.safeParse(data);
        if (!parsed.success) {
          return Response.json(
            { error: "Invalid profile data" },
            { status: 400, headers: { "cache-control": "no-store" } },
          );
        }

        const sql = await getSql();
        const phone = parsed.data.phone || null;

        try {
          await sql.query(
            `insert into profiles (user_id,name,phone,address,lat,lon)
             values ($1,$2,$3,$4,null,null)
             on conflict (user_id) do update set
               name=$2,
               phone=$3,
               phone_verified_at=case when profiles.phone is distinct from excluded.phone then null else profiles.phone_verified_at end,
               address=$4,
               lat=null,
               lon=null,
               updated_at=now()`,
            [current.user.id, parsed.data.name, phone, parsed.data.address],
          );
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code ?? "")
            : "";
          if (code === "23505") {
            return Response.json(
              { error: "Phone number already registered" },
              { status: 409, headers: { "cache-control": "no-store" } },
            );
          }
          throw error;
        }

        return Response.json(
          { ok: true },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
