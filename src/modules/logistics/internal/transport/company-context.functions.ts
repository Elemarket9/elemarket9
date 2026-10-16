import {createServerFn} from "@tanstack/react-start";
import {setCookie,getCookie} from "@tanstack/react-start/server";
import {z} from "zod";
import {authMiddleware,getAuthenticatedUserId} from "@/modules/identity/public/auth/middleware";
import {getSql} from "@/lib/db";
import {assertPortalOperationHost} from "@/lib/security/portal-access.server";
import {isSharedEnvironment} from "@/lib/env.server";

export const listMyDeliveryCompanies=createServerFn({method:'GET'}).middleware([authMiddleware]).handler(async({context})=>{
 assertPortalOperationHost('provider');const sql=await getSql();
 const companies=await sql.query<{id:string;name:string;role:string}>(`select o.id,o.name,m.role from partner_organization_users m
 join partner_organizations o on o.id=m.organization_id and o.status='active'
 join partner_organization_capabilities c on c.organization_id=o.id and c.capability='delivery'
 where m.user_id=$1 and m.status='active' order by o.name,o.id`,[getAuthenticatedUserId(context)]);
 return {companies,selected:getCookie('elemarket_company')??null};
});
export const selectDeliveryCompany=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({organizationId:z.string().min(1).max(128)})).handler(async({data,context})=>{
 assertPortalOperationHost('provider');const sql=await getSql();
 const rows=await sql.query(`select o.id from partner_organizations o join partner_organization_users m
 on m.organization_id=o.id and m.status='active' where o.id=$1 and o.status='active' and m.user_id=$2`,[data.organizationId,getAuthenticatedUserId(context)]);
 if(!rows[0])throw new Error('Company membership unavailable');
 // This cookie is only a selection, never authorization. Every request rechecks
 // membership and resource ownership against it. SameSite mitigates forced switches.
 setCookie('elemarket_company',data.organizationId,{httpOnly:true,sameSite:'strict',secure:isSharedEnvironment(),path:'/',maxAge:28800});
 return {selected:data.organizationId};
});
