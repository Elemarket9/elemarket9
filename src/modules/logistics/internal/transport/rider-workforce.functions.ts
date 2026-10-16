import {lockCompanyOperation} from "@/lib/partner/transaction-authority.server";
import { assertPortalOperationHost } from "@/lib/security/portal-access.server";
import { randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, getAuthenticatedUserId } from "@/modules/identity/public/auth/middleware";
import { requireFreshSession } from "@/modules/identity/public/auth/verify.server";
import { requirePartnerAdmin } from "@/lib/partner/authorization.server";
import { getSql, withTransaction } from "@/lib/db";
import { ghanaPhoneSchema } from "@/modules/identity/public/auth/phone";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import type { JsonObject } from "@/lib/db-types";
const id=z.string().trim().min(1).max(128);
const invited=z.object({email:z.string().email().max(254).transform(v=>v.trim().toLowerCase()),name:z.string().trim().min(2).max(160),phone:ghanaPhoneSchema,staffReference:z.string().trim().max(100).optional(),riderType:z.enum(["employee","contractor"]),vehicleType:z.string().trim().max(80).optional(),vehicleRegistration:z.string().trim().max(80).optional(),region:z.string().trim().max(100).optional(),capability:z.enum(['rider','pickup_attendant','dispatcher','supervisor']).default('rider'),pickupLocationId:id.optional()}).refine(v=>(v.capability==='pickup_attendant')===Boolean(v.pickupLocationId),'Attendant invitation requires a pickup location');
export const inviteProviderRider=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(invited).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAdmin(actor,"delivery");await requireFreshSession();
 await enforceRateLimit("rider-invite",{windowSeconds:3600,maxRequests:30,subject:`${access.organizationId}:${actor}`});
 const inviteId=`rinv_${randomUUID().replaceAll("-","")}`;
 return withTransaction(async tx=>{
  await lockCompanyOperation(tx,access.organizationId,actor,true);const org=[true];
  if(!org[0]) throw new Error("Delivery organization is inactive");
  if(data.pickupLocationId && !(await tx.query(`select id from pickup_locations where id=$1 and organization_id=$2 and status='active'`,[data.pickupLocationId,access.organizationId]))[0])throw new Error('Pickup location unavailable');
  await tx.query(`update provider_rider_invitations set status='expired',updated_at=now()
    where organization_id=$1 and lower(invited_email)=lower($2) and status='pending' and expires_at<=now()`,
    [access.organizationId,data.email]);
  await tx.query(`insert into provider_rider_invitations
   (id,organization_id,invited_email,full_name,mobile_phone,staff_reference,rider_type,vehicle_type,vehicle_registration,operating_region,created_by,capability,pickup_location_id)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
   [inviteId,access.organizationId,data.email,data.name,data.phone,data.staffReference??null,data.riderType,data.vehicleType??null,data.vehicleRegistration??null,data.region??null,actor,data.capability,data.pickupLocationId??null]);
  await tx.query(`insert into provider_rider_invitation_outbox(invitation_id) values($1)`,[inviteId]);
  await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata) values($1,$2,'rider.invited','rider_invitation',$3,'success',$4::jsonb)`,[access.organizationId,actor,inviteId,JSON.stringify({email:data.email})]);
  return {invited:true,inviteId,notificationQueued:true};
 });
});
export const listProviderRiders=createServerFn({method:"GET"}).middleware([authMiddleware]).validator(z.object({page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAdmin(actor,"delivery");const sql=await getSql();const offset=(data.page-1)*data.pageSize;
 const [members,invites,counts]=await Promise.all([
  sql.query<JsonObject>(`select m.user_id as "userId",u.name,u.email,pc.status,pc.capability,m.staff_reference as "staffReference",pc.accepted_at::text as "activatedAt",
    (select count(*)::int from delivery_jobs j join delivery_providers p on p.id=j.provider_id and p.partner_organization_id=m.organization_id
      where j.handover_rider_user_id=m.user_id and j.status in ('assigned','accepted','picked_up','in_transit')) as "openJobs",
    (select count(*)::int from delivery_jobs j join delivery_providers p on p.id=j.provider_id and p.partner_organization_id=m.organization_id
      where j.handover_rider_user_id=m.user_id and j.status='delivered') as "completedJobs"
    from partner_organization_users m join "user" u on u.id=m.user_id
    join delivery_personnel_capabilities pc on pc.organization_id=m.organization_id and pc.user_id=m.user_id
    where m.organization_id=$1 order by m.created_at desc,pc.capability limit $2 offset $3`,[access.organizationId,data.pageSize,offset]),
  sql.query<JsonObject>(`select i.id,i.full_name as name,i.invited_email as email,i.mobile_phone as phone,i.capability,
    case when i.status='pending' and i.expires_at<=now() then 'expired' else i.status end as status,
    coalesce(outbox.status,'not_queued') as "emailStatus",i.expires_at::text as "expiresAt",i.created_at::text as "createdAt"
    from provider_rider_invitations i left join provider_rider_invitation_outbox outbox on outbox.invitation_id=i.id
    where i.organization_id=$1 order by i.created_at desc limit $2 offset $3`,[access.organizationId,data.pageSize,offset]),
  sql.query<{members:number;invitations:number}>(`select
   (select count(*)::int from delivery_personnel_capabilities where organization_id=$1) as members,
   (select count(*)::int from provider_rider_invitations where organization_id=$1) as invitations`,[access.organizationId])
 ]);
 return {members,invites,counts:counts[0],page:data.page,pageSize:data.pageSize};
});
export const updateProviderRider=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({userId:id,capability:z.enum(['rider','pickup_attendant','dispatcher','supervisor']).default('rider'),action:z.enum(["suspend","reactivate","revoke"])})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAdmin(actor,"delivery");await requireFreshSession();
 await enforceRateLimit("rider-change",{windowSeconds:3600,maxRequests:60,subject:actor});
 return withTransaction(async tx=>{
  await lockCompanyOperation(tx,access.organizationId,actor,true);const org=[true];if(!org[0])throw new Error("Unknown provider organization");
  const rows=await tx.query<{status:string;activated_at:string|null}>(`select status,accepted_at::text as activated_at from delivery_personnel_capabilities where organization_id=$1 and user_id=$2 and capability=$3 for update`,[access.organizationId,data.userId,data.capability]);
  if(!rows[0])throw new Error("Rider membership unavailable");
  if(data.action==='reactivate' && rows[0].status!=='suspended')throw new Error("Only suspended riders may be reactivated");
  if(data.action==='reactivate' && !rows[0].activated_at)throw new Error("Rider must personally accept an invitation before activation");
  if(data.action==='revoke' && rows[0].status==='revoked')throw new Error("Membership already revoked");
  const status=data.action==='reactivate'?'active':data.action==='suspend'?'suspended':'revoked';
  await tx.query(`update delivery_personnel_capabilities set status=$3 where organization_id=$1 and user_id=$2 and capability=$4`,[access.organizationId,data.userId,status,data.capability]);
  // A suspended rider can never verify an already issued OTP. Prevent any
  // active SMS handovers from being reassigned while their memberships change.
  await tx.query(`update delivery_handover_requests r set state='failed',updated_at=now() from delivery_jobs j
    join delivery_providers p on p.id=j.provider_id
    where r.job_id=j.id and p.partner_organization_id=$1 and r.rider_user_id=$2 and r.state in ('issued','issuing')`,[access.organizationId,data.userId]);
  await tx.query(`update otp_challenges c set status='superseded',updated_at=now()
    from order_delivery_handover h join delivery_jobs j on j.id=h.job_id join delivery_providers p on p.id=j.provider_id
    where c.id=h.challenge_id and p.partner_organization_id=$1 and h.initiated_by=$2 and c.status in ('pending','sending')`,[access.organizationId,data.userId]);
  await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome,metadata)
    values($1,$2,$3,'rider_membership',$4,'success','{}'::jsonb)`,[access.organizationId,actor,`rider.${data.action}`,data.userId]);
  return {updated:true,status};
 });
});
export const cancelProviderRiderInvite=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({invitationId:id})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAdmin(actor,"delivery");await requireFreshSession();
 return withTransaction(async tx=>{
  await lockCompanyOperation(tx,access.organizationId,actor,true);
  const r=await tx.query<{id:string}>(`update provider_rider_invitations set status='cancelled',updated_at=now()
    where id=$1 and organization_id=$2 and status='pending' returning id`,[data.invitationId,access.organizationId]);
  if(!r[0])throw new Error("Pending invitation not found");
  await tx.query(`update provider_rider_invitation_outbox set status='cancelled',lease_token=null,updated_at=now()
    where invitation_id=$1 and status<>'accepted'`,[data.invitationId]);
  await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome) values($1,$2,'rider.invitation_cancelled','rider_invitation',$3,'success')`,[access.organizationId,actor,data.invitationId]);return {cancelled:true};
 });
});
export const listMyRiderInvites=createServerFn({method:"GET"}).middleware([authMiddleware]).handler(async({context})=>{
 assertPortalOperationHost('provider');
 const userId=getAuthenticatedUserId(context);const sql=await getSql();
 return sql.query<JsonObject>(`select i.id,i.full_name as name,i.capability,o.name as "organizationName",i.expires_at::text as "expiresAt"
  from provider_rider_invitations i join partner_organizations o on o.id=i.organization_id and o.status='active'
  join "user" u on u.id=$1 and u."emailVerified"=true and lower(u.email)=lower(i.invited_email)
  where i.status='pending' and i.expires_at>now() order by i.created_at desc limit 50`,[userId]);
});
export const reissueProviderInvitation=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({invitationId:id})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAdmin(actor,'delivery');await requireFreshSession();
 await enforceRateLimit('personnel-invite-reissue',{windowSeconds:3600,maxRequests:10,subject:`${access.organizationId}:${actor}`});
 return withTransaction(async tx=>{
  await lockCompanyOperation(tx,access.organizationId,actor,true);
  const invitation=await tx.query(`update provider_rider_invitations i set notification_version=notification_version+1,updated_at=now()
   where i.id=$1 and i.organization_id=$2 and i.status='pending' and i.expires_at>now()
    and not exists(select 1 from provider_rider_invitation_outbox o where o.invitation_id=i.id and o.status='processing' and o.lease_expires_at>now()) returning i.id`,[data.invitationId,access.organizationId]);
  if(!invitation[0])throw new Error('Invitation expired, unavailable, or being transmitted');
  await tx.query(`insert into provider_rider_invitation_outbox(invitation_id) values($1) on conflict(invitation_id) do update
   set status='pending',attempts=0,next_attempt_at=now(),lease_token=null,lease_expires_at=null,accepted_at=null,last_error_code=null`,[data.invitationId]);
  await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome) values($1,$2,'personnel.invitation.resent','rider_invitation',$3,'success')`,[access.organizationId,actor,data.invitationId]);
  return {queued:true};
 });
});
export const updatePersonnelDetails=createServerFn({method:'POST'}).middleware([authMiddleware])
 .validator(z.object({userId:id,staffReference:z.string().trim().max(100)})).handler(async({data,context})=>{
 const actor=getAuthenticatedUserId(context);const access=await requirePartnerAdmin(actor,'delivery');await requireFreshSession();
 return withTransaction(async tx=>{
  await lockCompanyOperation(tx,access.organizationId,actor,true);
  if(!(await tx.query(`update partner_organization_users set staff_reference=$3 where organization_id=$1 and user_id=$2 and status<>'revoked' returning user_id`,[access.organizationId,data.userId,data.staffReference]))[0])throw new Error('Personnel unavailable');
  await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome) values($1,$2,'personnel.details.updated','personnel',$3,'success')`,[access.organizationId,actor,data.userId]);return {updated:true};
 });
});
export const acceptRiderInvite=createServerFn({method:"POST"}).middleware([authMiddleware]).validator(z.object({invitationId:id})).handler(async({data,context})=>{
 assertPortalOperationHost('provider');
 const actor=getAuthenticatedUserId(context);await requireFreshSession();await enforceRateLimit("rider-accept",{windowSeconds:3600,maxRequests:15,subject:actor});
 return withTransaction(async tx=>{
  const scope=await tx.query<{organization_id:string}>(`select organization_id from provider_rider_invitations where id=$1`,[data.invitationId]);
  if(!scope[0])throw new Error('Invitation unavailable');
  await tx.query(`select id from partner_organizations where id=$1 and status='active' for update`,[scope[0].organization_id]);
  const r=await tx.query<{organization_id:string;staff_reference:string|null;capability:string;pickup_location_id:string|null}>(`select i.organization_id,i.staff_reference,i.capability,i.pickup_location_id
   from provider_rider_invitations i join "user" u on u.id=$2 and u."emailVerified"=true and lower(u.email)=lower(i.invited_email)
   join partner_organizations o on o.id=i.organization_id and o.status='active'
   join profiles profile on profile.user_id=u.id and profile.phone=i.mobile_phone and profile.phone_verified_at is not null
   where i.id=$1 and i.status='pending' and i.expires_at>now() for update of i`,[data.invitationId,actor]);
  if(!r[0])throw new Error("Invitation requires a verified account email and a verified phone matching the invitation");
  const prev=await tx.query<{status:string;role:string}>(`select status,role from partner_organization_users where organization_id=$1 and user_id=$2 for update`,[r[0].organization_id,actor]);
  if(prev[0]){
   // Legitimate legacy riders must personally accept a NEW invitation before
   // being trusted. Do not silently grandfather admin-provisioned accounts.
   if(prev[0].status!=='active')
     throw new Error("Existing membership needs administrator review");
   await tx.query(`update partner_organization_users set staff_reference=coalesce(staff_reference,$3)
     where organization_id=$1 and user_id=$2 and status='active'`,
     [r[0].organization_id,actor,r[0].staff_reference]);
  }else{
   await tx.query(`insert into partner_organization_users(organization_id,user_id,role,status,activated_at,staff_reference) values($1,$2,$4,'active',now(),$3)`,[r[0].organization_id,actor,r[0].staff_reference,r[0].capability==='rider'?'rider':'analyst']);
  }
  await tx.query(`update provider_rider_invitations set status='accepted',accepted_by=$2,accepted_at=now(),updated_at=now() where id=$1`,[data.invitationId,actor]);
  const capability=await tx.query(`insert into delivery_personnel_capabilities(organization_id,user_id,capability,status,accepted_at,granted_by)
   values($1,$2,$3,'active',now(),$4) on conflict(organization_id,user_id,capability) do update set status='active'
   where delivery_personnel_capabilities.status<>'revoked' returning user_id`,[r[0].organization_id,actor,r[0].capability,data.invitationId]);
  if(!capability[0])throw new Error('Revoked capability requires independent review');
  if(r[0].pickup_location_id){
   if(!(await tx.query(`select id from pickup_locations where id=$1 and organization_id=$2 and status='active' for update`,[r[0].pickup_location_id,r[0].organization_id]))[0])throw new Error('Pickup location unavailable');
   await tx.query(`insert into pickup_location_attendants(organization_id,location_id,user_id) values($1,$2,$3)
    on conflict(location_id,user_id) do update set status='active' where pickup_location_attendants.status<>'revoked'`,[r[0].organization_id,r[0].pickup_location_id,actor]);
  }
  await tx.query(`insert into partner_audit_events(organization_id,user_id,action,resource_type,resource_id,outcome) values($1,$2,'rider.invitation_accepted','rider_invitation',$3,'success')`,[r[0].organization_id,actor,data.invitationId]);
  return {active:true};
 });
});
