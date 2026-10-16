import {randomUUID} from "node:crypto";
import {getSql,withTransaction} from "@/lib/db";
import {getDeliverySmsTransport} from "./delivery-sms/registry.server";
/** Collection-ready messages contain no handover OTP and cannot establish receipt. */
export async function dispatchCollectionNotifications(limit=20){
 const token=randomUUID();
 const maintenance=await getSql();
 await maintenance.query(`update delivery_notification_outbox set status='failed',lease_token=null,lease_until=null where status='processing' and lease_until<now() and attempts>=5`);
 const escalated=await maintenance.query(`insert into delivery_operation_events(id,job_id,organization_id,actor_user_id,event_type,reason)
  select 'uncollected:'||j.id,j.id,p.partner_organization_id,'system:pickup-escalation','uncollected','Collection deadline passed; company custody review required'
  from delivery_jobs j join delivery_providers p on p.id=j.provider_id where j.handover_kind='pickup' and j.status='in_transit'
   and j.pickup_arrived_at is not null and j.collection_due_at<now() on conflict(id) do nothing returning id`);
 const pending=await withTransaction(tx=>tx.query<{id:string;phone:string;location_name:string}>(`with due as (
   select n.id from delivery_notification_outbox n where n.attempts<5 and n.next_attempt_at<=now()
    and (n.status in ('pending','failed') or(n.status='processing' and n.lease_until<now()))
    order by n.next_attempt_at limit $1 for update skip locked)
   update delivery_notification_outbox n set status='processing',lease_token=$2,lease_until=now()+interval '60 seconds',attempts=attempts+1
   from due,delivery_jobs j,orders o,pickup_locations l,delivery_providers p,partner_organizations org where n.id=due.id and j.id=n.job_id and o.id=j.order_id
    and p.id=j.provider_id and p.status='active' and org.id=p.partner_organization_id and org.status='active'
    and l.id=j.pickup_location_id and l.status='active' and j.status='in_transit' and j.pickup_arrived_at is not null
    and o.delivery_contact_snapshot_verified and o.delivery_contact_phone is not null
   returning n.id,o.delivery_contact_phone as phone,l.name as location_name`,[Math.max(1,Math.min(50,limit)),token]));
 let accepted=0,failed=0;
 for(const item of pending){
  try{
   const sql=await getSql();
   const lease=await sql.query(`update delivery_notification_outbox set lease_until=now()+interval '60 seconds' where id=$1 and lease_token=$2 and status='processing' and lease_until>now() returning id`,[item.id,token]);
   if(!lease[0])continue;
   await getDeliverySmsTransport().send(item.phone,`ELEMARKET: your parcel is ready for collection at ${item.location_name}. Inspect it before sharing a collection code. An authenticated attendant will request that code only when you arrive.`);
   const done=await sql.query(`update delivery_notification_outbox set status='accepted',accepted_at=now(),lease_token=null,lease_until=null where id=$1 and lease_token=$2 and status='processing' returning id`,[item.id,token]);
   if(done[0])accepted++;
  }catch{
   failed++;const sql=await getSql();await sql.query(`update delivery_notification_outbox set status='failed',lease_token=null,lease_until=null,next_attempt_at=now()+interval '5 minutes' where id=$1 and lease_token=$2`,[item.id,token]);
  }
 }
 return {claimed:pending.length,accepted,failed,escalated:escalated.length};
}
