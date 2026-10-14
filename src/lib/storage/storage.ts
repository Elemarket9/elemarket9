import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";

const uploadSchema = z.object({
  purpose: z.enum([
    "product-image",
    "profile-image",
    "business-document",
    "refund-evidence",
    "order-attachment",
    "financing-application-document",
  ]),
  contentType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().positive().max(560 * 1024),
  resourceId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
  extension: z.string().trim().max(8).optional(),
});

export const createStorageUploadUrl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(uploadSchema)
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await enforceRateLimit("storage-upload-url", {
      windowSeconds: 60,
      maxRequests: 20,
      subject: userId,
    });
    const { createUploadIntent } = await import("./storage.server");
    return createUploadIntent(userId, data);
  });


export const finalizeStorageUpload = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ uploadId: z.string().regex(/^upi_[A-Za-z0-9]+$/) }))
  .handler(async ({ data, context }) => {
    const userId = getAuthenticatedUserId(context);
    await enforceRateLimit("storage-upload-finalize", { windowSeconds: 60, maxRequests: 20, subject: userId });
    const { finalizeUpload } = await import("./storage.server");
    return finalizeUpload(userId, data.uploadId);
  });
