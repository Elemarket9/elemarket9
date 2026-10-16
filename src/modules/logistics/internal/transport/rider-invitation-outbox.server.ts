import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { sendAuthEmail } from "@/modules/identity/public/auth/email.server";

function invitationLanding():string {
 const configured=(process.env.ELEMARKET_RIDER_PORTAL_ORIGIN??"").trim();
 const url=new URL(configured);
 if(url.protocol!=="https:" || url.username || url.password || url.search || url.hash || url.pathname!=="/")
   throw new Error("Rider invitation origin must be an approved HTTPS origin");
 return new URL("/provider/rider", url).toString();
}

/** Lease and retry invitation delivery. Provider accepted != inbox delivered. */
export async function dispatchRiderInvitationOutbox(limit=15) {
 const bounded=Math.max(1,Math.min(50,Math.trunc(limit)));
 // Expired invitation is never reissued by retry; clean its queued email.
 await withTransaction(async tx=>{
   await tx.query(`update provider_rider_invitations set status='expired',updated_at=now()
     where status='pending' and expires_at<=now()`);
   await tx.query(`update provider_rider_invitation_outbox o set status='cancelled',updated_at=now()
     from provider_rider_invitations i where i.id=o.invitation_id and i.status<>'pending'
       and (o.status in ('pending','failed') or
         (o.status='processing' and o.lease_expires_at<now()))`);
   await tx.query(`update provider_rider_invitation_outbox set status='failed',
     lease_token=null,lease_expires_at=null,last_error_code='retry_limit_reached',updated_at=now()
     where status='processing' and lease_expires_at<now() and attempts>=5`);
   await tx.query(`update provider_rider_invitation_outbox set last_error_code='retry_limit_reached'
     where status='failed' and attempts>=5 and last_error_code is distinct from 'retry_limit_reached'`);
 });
 const token=randomUUID();
 const pending=await withTransaction(tx=>tx.query<{invitation_id:string;invited_email:string;full_name:string;notification_version:number}>(`
  with due as (select o.invitation_id from provider_rider_invitation_outbox o
    join provider_rider_invitations i on i.id=o.invitation_id
    where (o.status in ('pending','failed') or (o.status='processing' and o.lease_expires_at<now()))
      and o.attempts<5 and o.next_attempt_at<=now() and i.status='pending' and i.expires_at>now()
    order by o.next_attempt_at limit $1 for update of o skip locked)
  update provider_rider_invitation_outbox o set status='processing',lease_token=$2,
    lease_expires_at=now()+interval '90 seconds',attempts=attempts+1,updated_at=now()
    from due join provider_rider_invitations i on i.id=due.invitation_id
    where o.invitation_id=due.invitation_id
    returning o.invitation_id,i.invited_email,i.full_name,i.notification_version`,[bounded,token]));
 let accepted=0,failed=0;
 for(const item of pending){
   try {
     // Refresh each parcel's lease immediately before transport. A previous
     // item's slow provider call must not let an expired worker send this one.
     const leaseSql=await getSql();
     const live=await leaseSql.query(`update provider_rider_invitation_outbox o
       set lease_expires_at=now()+interval '90 seconds',updated_at=now()
       from provider_rider_invitations i where o.invitation_id=$1 and i.id=o.invitation_id
         and i.status='pending' and i.expires_at>now() and o.lease_token=$2
         and o.status='processing' and o.lease_expires_at>now() returning o.invitation_id`,[item.invitation_id,token]);
     if(!live[0]) continue;
     await sendAuthEmail({kind:'rider_invitation',to:item.invited_email,name:item.full_name,
       url:`${invitationLanding()}?invitationId=${encodeURIComponent(item.invitation_id)}&notification=${item.notification_version}`});
     const sql=await getSql();
     const rows=await sql.query(`update provider_rider_invitation_outbox set status='accepted',accepted_at=now(),
       lease_token=null,lease_expires_at=null,updated_at=now() where invitation_id=$1 and lease_token=$2
       and status='processing' returning invitation_id`,[item.invitation_id,token]);
     if(rows[0]) accepted++;
   }catch{
     failed++;
     const sql=await getSql();
     await sql.query(`update provider_rider_invitation_outbox set status='failed',
       last_error_code='provider_unavailable',lease_token=null,lease_expires_at=null,
       next_attempt_at=now()+least(3600,power(2,least(attempts,7))::int*30)*interval '1 second',updated_at=now()
       where invitation_id=$1 and lease_token=$2 and status='processing'`,[item.invitation_id,token]);
   }
 }
 return {claimed:pending.length,accepted,failed};
}
