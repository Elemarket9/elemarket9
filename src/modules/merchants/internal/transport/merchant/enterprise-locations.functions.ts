import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { createEnterpriseLocation, listEnterpriseLocations, listEnterpriseStaff, setEnterpriseStaffAssignment, transferEnterpriseInventory, receiveEnterpriseInventoryTransfer, type EnterpriseLocationRow, type EnterpriseStaffRole, type EnterpriseStaffRow } from "@/modules/merchants/public/enterprise-multilocation.server";

const merchantId=z.string().trim().min(1).max(128);
const locationType=z.enum(["store","warehouse","distribution_center","fulfillment_center","pickup_point","office","service_center"]);

export const loadEnterpriseLocations=createServerFn({method:"GET"}).middleware([authMiddleware]).validator(z.object({merchantId})).handler(async({data,context}): Promise<EnterpriseLocationRow[]> => listEnterpriseLocations(data.merchantId,getAuthenticatedUserId(context)));

export const createEnterpriseLocationFn=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId,name:z.string().trim().min(2).max(160),address:z.string().trim().min(4).max(400),city:z.string().trim().min(2).max(120),countryCode:z.string().trim().length(2).optional(),locationType,externalLocationKey:z.string().trim().min(1).max(160).optional(),latitude:z.number().finite().min(-90).max(90).optional(),longitude:z.number().finite().min(-180).max(180).optional(),timezone:z.string().trim().min(1).max(80).optional()})).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context);
  await requireFreshSession();
  await enforceRateLimit("enterprise-location-create",{windowSeconds:60,maxRequests:10,subject:userId});
  return createEnterpriseLocation({...data,userId});
});

export const requestEnterpriseInventoryTransfer=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId,productId:z.string().min(1).max(128),fromLocationId:z.string().min(1).max(128),toLocationId:z.string().min(1).max(128),quantity:z.number().int().min(1).max(1000000),idempotencyKey:z.string().min(16).max(128)})).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context);
  await enforceRateLimit("enterprise-inventory-transfer",{windowSeconds:60,maxRequests:30,subject:userId});
  return transferEnterpriseInventory({...data,userId});
});

export const receiveEnterpriseInventoryTransferFn=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId,transferId:z.string().min(1).max(128)})).handler(async({data,context})=>{
  const userId=getAuthenticatedUserId(context);
  await enforceRateLimit("enterprise-inventory-receive",{windowSeconds:60,maxRequests:30,subject:userId});
  return receiveEnterpriseInventoryTransfer({...data,userId});
});


const enterpriseStaffRole=z.enum(["enterprise_admin","operations_manager","location_manager","warehouse_operator","inventory_manager","fulfillment_operator","support_manager","analyst"]);

export const loadEnterpriseStaff=createServerFn({method:"GET"}).middleware([authMiddleware]).validator(z.object({merchantId})).handler(async({data,context}):Promise<EnterpriseStaffRow[]>=>listEnterpriseStaff(data.merchantId,getAuthenticatedUserId(context)));

export const setEnterpriseStaffAssignmentFn=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({merchantId,targetEmail:z.string().email().max(320),locationId:z.string().min(1).max(128).nullable().optional(),role:enterpriseStaffRole,status:z.enum(["active","suspended","revoked"])})).handler(async({data,context})=>{
  const actorUserId=getAuthenticatedUserId(context);
  await requireFreshSession();
  await enforceRateLimit("enterprise-staff-assignment",{windowSeconds:60,maxRequests:20,subject:actorUserId});
  return setEnterpriseStaffAssignment({...data,actorUserId,role:data.role as EnterpriseStaffRole});
});
