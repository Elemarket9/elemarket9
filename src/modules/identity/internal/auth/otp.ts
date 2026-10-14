import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { assertSameSiteRequest } from "./isolation.server";
import { requireUserId } from "./verify.server";

const emailPurposeSchema = z.enum(["signup", "login", "password_reset", "transactional"]);

const requestSchema = z.object({
  number: z.string().trim().min(8).max(16),
  purpose: z.enum(["signup", "login", "phone_verification", "password_reset", "transactional"]),
  expiryMinutes: z.number().int().min(1).max(10).optional(),
});

const verifySchema = z.object({
  challengeId: z.string().regex(/^otp_[a-f0-9]{32}$/),
  code: z.string().regex(/^\d{6}$/),
  purpose: z.enum(["signup", "login", "phone_verification", "password_reset", "transactional"]),
});

const emailRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  purpose: emailPurposeSchema,
  expiryMinutes: z.number().int().min(1).max(10).optional(),
});

export const requestOtpCode = createServerFn({ method: "POST" })
  .validator(requestSchema)
  .handler(async ({ data }) => {
    assertSameSiteRequest();
    const requiresAuthenticatedUser = data.purpose === "phone_verification" || data.purpose === "transactional";
    const userId = requiresAuthenticatedUser ? await requireUserId() : undefined;
    const { requestOtp } = await import("./otp/otp.server");
    return requestOtp({ ...data, ...(userId ? { userId } : {}) });
  });

export const verifyOtpCode = createServerFn({ method: "POST" })
  .validator(verifySchema)
  .handler(async ({ data }) => {
    assertSameSiteRequest();
    const requiresAuthenticatedUser = data.purpose === "phone_verification" || data.purpose === "transactional";
    const userId = requiresAuthenticatedUser ? await requireUserId() : undefined;
    const { verifyOtp } = await import("./otp/otp.server");
    return verifyOtp({ ...data, expectedPurpose: data.purpose, ...(userId ? { userId } : {}) });
  });


export const requestEmailOtpCode = createServerFn({ method: "POST" })
  .validator(emailRequestSchema)
  .handler(async ({ data }) => {
    assertSameSiteRequest();
    const requiresAuthenticatedUser = data.purpose === "transactional";
    const userId = requiresAuthenticatedUser ? await requireUserId() : undefined;
    const { requestEmailOtp } = await import("./email/email-otp.server");
    return requestEmailOtp({ ...data, ...(userId ? { userId } : {}) });
  });

export const verifyEmailOtpCode = createServerFn({ method: "POST" })
  .validator(z.object({
    challengeId: z.string().regex(/^otp_[a-f0-9]{32}$/),
    code: z.string().regex(/^\d{6}$/),
    purpose: emailPurposeSchema,
  }))
  .handler(async ({ data }) => {
    assertSameSiteRequest();
    const requiresAuthenticatedUser = data.purpose === "transactional";
    const userId = requiresAuthenticatedUser ? await requireUserId() : undefined;
    const { verifyEmailOtp } = await import("./email/email-otp.server");
    return verifyEmailOtp({
      challengeId: data.challengeId,
      code: data.code,
      expectedPurpose: data.purpose,
      ...(userId ? { userId } : {}),
    });
  });
