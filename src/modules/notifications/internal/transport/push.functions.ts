import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { registerPushDevice, unregisterPushDevice } from "@/modules/notifications/public/notifications/push/push.server";

const registerSchema = z.object({
  token: z.string().trim().min(20).max(4096),
  platform: z.enum(["android", "ios", "web"]),
  appVersion: z.string().trim().max(64).optional(),
  deviceId: z.string().trim().max(256).optional(),
});

const unregisterSchema = z.object({ token: z.string().trim().min(20).max(4096) });

export const registerPushToken = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(registerSchema)
  .handler(({ data, context }) => registerPushDevice({ userId: getAuthenticatedUserId(context), ...data }));

export const unregisterPushToken = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(unregisterSchema)
  .handler(({ data, context }) => unregisterPushDevice({ userId: getAuthenticatedUserId(context), ...data }));
