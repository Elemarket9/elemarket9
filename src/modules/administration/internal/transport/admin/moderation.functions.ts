import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { JsonValue } from "@/lib/db-types";
import { getSql } from "@/lib/db";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireAdminForUserId, getAdminCapabilitiesForUserId } from "@/modules/identity/public/auth/authorization.server";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";

export type AdminModerationData = {
  merchants: Array<{ id:string; name:string; status:string; tier:string; settlementModel:string; catalogSource:string; ownerId:string|null; ownerEmail:string|null }>;
  customers: Array<{ id:string; name:string; email:string; status:string; createdAt:string }>;
  products: Array<{ id:string; name:string; merchantId:string; merchantName:string; status:string; price:string; createdAt:string }>;
};

export const loadAdminModeration = createServerFn({ method:"GET" }).middleware([authMiddleware]).handler(async ({context}):Promise<AdminModerationData> => {
  const adminId=getAuthenticatedUserId(context);
  const perms=await getAdminCapabilitiesForUserId(adminId);
  const can=(cap:string)=>perms.includes('admin.full')||perms.includes(cap as typeof perms[number]);
  if (!['admin.merchants.moderate','admin.customers.moderate','admin.products.moderate'].some(can)) throw new Error('Forbidden');
  const sql=await getSql();
  const [merchants,customers,products]=await Promise.all([
    can('admin.merchants.moderate') ? sql.query<any>(`select m.id,m.name,m.status,m.tier,m.settlement_model,m.catalog_source,ma.user_id as owner_id,u.email as owner_email from merchants m left join merchant_accounts ma on ma.merchant_id=m.id left join "user" u on u.id=ma.user_id order by case when m.status='suspended' then 0 else 1 end,m.created_at desc limit 100`) : Promise.resolve([]),
    can('admin.customers.moderate') ? sql.query<any>(`select id,name,email,"moderationStatus" as status,to_char("createdAt" at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as "createdAt" from "user" where role='customer' order by case when "moderationStatus"='blacklisted' then 0 else 1 end,"createdAt" desc limit 100`) : Promise.resolve([]),
    can('admin.products.moderate') ? sql.query<any>(`select p.id,p.name,p.merchant_id,p.status,p.price::text,to_char(p.created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as created_at,m.name as merchant_name from products p join merchants m on m.id=p.merchant_id where p.status in ('pending_review','suspended','active') order by case p.status when 'pending_review' then 0 when 'suspended' then 1 else 2 end,p.created_at desc limit 100`) : Promise.resolve([]),
  ]);
  return { merchants:merchants.map((r:any)=>({id:r.id,name:r.name,status:r.status,tier:r.tier,settlementModel:r.settlement_model,catalogSource:r.catalog_source,ownerId:r.owner_id??null,ownerEmail:r.owner_email??null})), customers:customers.map((r:any)=>({id:r.id,name:r.name,email:r.email,status:r.status,createdAt:r.createdAt})), products:products.map((r:any)=>({id:r.id,name:r.name,merchantId:r.merchant_id,merchantName:r.merchant_name,status:r.status,price:r.price,createdAt:r.created_at})) };
});

const merchantAction=z.object({merchantId:z.string().min(1).max(128),action:z.enum(["suspend","reinstate"]),reason:z.string().trim().min(10).max(2000)});
export const moderateMerchant=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(merchantAction).handler(async({data,context})=>{const adminId=getAuthenticatedUserId(context);await requireAdminForUserId(adminId, "admin.merchants.moderate");await requireFreshSession();const sql=await getSql();const rows=await sql.query<{result:JsonValue}>(`select admin_set_merchant_status($1,$2,$3,$4) result`,[data.merchantId,adminId,data.action==='reinstate'?'active':'suspended',data.reason.trim()]);return rows[0]?.result??null;});

const customerAction=z.object({userId:z.string().min(1).max(128),action:z.enum(["blacklist","unblacklist"]),reason:z.string().trim().min(10).max(2000)});
export const moderateCustomer=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(customerAction).handler(async({data,context})=>{const adminId=getAuthenticatedUserId(context);await requireAdminForUserId(adminId, "admin.customers.moderate");await requireFreshSession();const sql=await getSql();const rows=await sql.query<{result:JsonValue}>(`select admin_set_customer_blacklist($1,$2,$3,$4) result`,[data.userId,adminId,data.action==='blacklist',data.reason.trim()]);return rows[0]?.result??null;});


const productAction=z.object({productId:z.string().min(1).max(128),action:z.enum(["approve","suspend","archive"]),reason:z.string().trim().min(10).max(2000)});
export const moderateProduct=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(productAction).handler(async({data,context})=>{const adminId=getAuthenticatedUserId(context);await requireAdminForUserId(adminId, "admin.products.moderate");await requireFreshSession();const sql=await getSql();const status=data.action==='approve'?'active':data.action==='archive'?'archived':'suspended';const rows=await sql.query<{result:JsonValue}>(`select admin_set_product_status($1,$2,$3,$4) result`,[data.productId,adminId,status,data.reason.trim()]);return rows[0]?.result??null;});

const enterpriseAction=z.object({merchantId:z.string().min(1).max(128),action:z.enum(["enable","disable"]),reason:z.string().trim().min(12).max(2000)});
export const setMerchantEnterpriseMode=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(enterpriseAction).handler(async({data,context})=>{
  const adminId=getAuthenticatedUserId(context); await requireAdminForUserId(adminId, "admin.enterprise.manage"); await requireFreshSession(); const sql=await getSql();
  const rows=await sql.query<{result:JsonValue}>(`with identity as (select set_config('app.user_id',$2,true) as user_id)
     select admin_set_merchant_enterprise_mode($1,$2,$3,$4) result from identity`,[data.merchantId,adminId,data.action==='enable',data.reason.trim()]);
  return rows[0]?.result??null;
});

/** Operator-safe queue: no taxpayer IDs, documents, private order data or raw provider payloads. */
export type AdminOperationsQueues = {
  applications: Array<{
    id: string; businessName: string; status: string; categories: string[];
    createdAt: string; emailVerified: boolean; phoneVerified: boolean;
  }>;
  categories: Array<{ key: string; name: string; active: boolean;
    subcategories: Array<{ key: string; name: string; active: boolean }> }>;
};
export const loadAdminOperationsQueues = createServerFn({ method: "GET" })
  .middleware([authMiddleware]).handler(async ({ context }): Promise<AdminOperationsQueues> => {
    const adminId = getAuthenticatedUserId(context);
    const perms = await getAdminCapabilitiesForUserId(adminId);
    const can=(cap:string)=>perms.includes('admin.full')||perms.includes(cap as typeof perms[number]);
    if (!can('admin.merchants.review') && !can('admin.categories.manage')) throw new Error('Forbidden');
    const sql = await getSql();
    const [applications, categories, subcategories] = await Promise.all([
      can('admin.merchants.review') ? sql.query<{id:string;business_name:string;status:string;catalog_categories:string[];created_at:string;email_verified:boolean;phone_verified:boolean}>(
        `select a.id,a.business_name,a.status,a.catalog_categories,
                to_char(a.created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as created_at,
                exists(select 1 from merchant_verification_checks v
                  where v.application_id=a.id and v.check_type='email' and v.status='verified') as email_verified,
                exists(select 1 from merchant_verification_checks v
                  where v.application_id=a.id and v.check_type='phone' and v.status='verified') as phone_verified
           from merchant_applications a where a.status in ('pending','reviewing')
          order by a.created_at asc limit 100`) : Promise.resolve([]),
      can('admin.categories.manage') ? sql.query<{category_key:string;name:string;active:boolean}>(
        `select category_key,name,active from category_taxonomy order by sort_order,category_key`) : Promise.resolve([]),
      can('admin.categories.manage') ? sql.query<{category_key:string;subcategory_key:string;name:string;active:boolean}>(
        `select category_key,subcategory_key,name,active from category_subcategories
          order by category_key,sort_order,subcategory_key`) : Promise.resolve([]),
    ]);
    return {
      applications: applications.map(a=>({id:a.id,businessName:a.business_name,status:a.status,
        categories:a.catalog_categories??[],createdAt:a.created_at,
        emailVerified:Boolean(a.email_verified),phoneVerified:Boolean(a.phone_verified)})),
      categories: categories.map(c=>({key:c.category_key,name:c.name,active:Boolean(c.active),
        subcategories:subcategories.filter(s=>s.category_key===c.category_key).map(s=>({
          key:s.subcategory_key,name:s.name,active:Boolean(s.active),
        }))})),
    };
  });

/** Minimal enterprise queue. A delegated enterprise manager does not automatically
 * get merchant private documents or customer/order records. */
export const loadEnterpriseMerchantCandidates = createServerFn({ method: "GET" })
  .middleware([authMiddleware]).handler(async ({ context }) => {
    const actor = getAuthenticatedUserId(context);
    await requireAdminForUserId(actor, "admin.enterprise.manage");
    const sql = await getSql();
    return sql.query<{id:string;name:string;status:string;tier:string;catalogSource:string;verified:boolean}>(
      `select id,name,status,tier,catalog_source as "catalogSource",verified
         from merchants order by case when tier='enterprise' then 0 else 1 end,
             updated_at desc limit 250`,
    );
  });
