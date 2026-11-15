import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";

const schema = z.object({groupId:z.string().min(16).max(128)});
export const createGroupPaymentIntent = createServerFn({method:"POST"})
  .middleware([authMiddleware])
  .validator(schema)
  .handler(async ({data,context})=>{
    const {startCustomerGroupPayment}=await import("./group-checkout.server");
    return startCustomerGroupPayment({groupId:data.groupId,userId:getAuthenticatedUserId(context)});
  });
export const getGroupPaymentStatus = createServerFn({method:"GET"})
  .middleware([authMiddleware])
  .validator(schema)
  .handler(async ({data,context})=>{
    const {getCustomerGroupPaymentStatus}=await import("./group-checkout.server");
    const {enforceRateLimit}=await import("@/lib/security/rate-limit.server");
    const userId=getAuthenticatedUserId(context);
    await enforceRateLimit("group-payment-status",{windowSeconds:60,maxRequests:30,subject:userId});
    return getCustomerGroupPaymentStatus({groupId:data.groupId,userId});
  });
