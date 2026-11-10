// Test fixture: deliver a paid order through the real rider-OTP handover records
// with every database guard active (no triggers are suspended).
//
// The rider's SMS and code entry happen outside the database; what the database
// demands as proof is reproduced exactly: an active partner organization and
// delivery provider, a rider with the accepted "rider" capability, a delivery job
// moved assigned -> accepted -> picked_up -> in_transit -> delivered, a verified
// delivery_handover OTP challenge to the order's verified contact phone, a
// consumed OTP verifier, and a verified handover initiated and verified by that
// rider. The handover instant `at` is the controlled test clock: receipt time,
// and therefore the settlement hold, is derived from it.
import { randomBytes } from "node:crypto";

const id = (prefix) => `${prefix}_${randomBytes(6).toString("hex")}`;

export async function deliverWithRiderOtp(sql, { orderId, at = new Date() }) {
  const T = new Date(at).toISOString();
  const [order] = await sql.query(
    `select id, user_id, status, delivery_contact_phone from orders where id=$1`, [orderId]);
  if (!order) throw new Error("order not found");
  for (const next of ["confirmed", "fulfilling", "shipped"]) {
    if (order.status === "paid" || order.status === "confirmed" || order.status === "fulfilling") {
      const [row] = await sql.query(`update orders set status=$2 where id=$1 returning status`, [orderId, next]);
      order.status = row.status;
    }
  }
  if (order.status !== "shipped") throw new Error(`order must reach shipped, is ${order.status}`);

  const org = id("porg"), provider = id("dprov"), rider = id("rider"), job = id("djob"), challenge = id("otpc");
  await sql.query(`insert into "user"(id,name,email,"emailVerified") values($1,'Simulated Rider',$2,true)`, [rider, `${rider}@rider.test`]);
  await sql.query(`insert into partner_organizations(id,name,status) values($1,'Simulated Delivery Partner','active')`, [org]);
  await sql.query(
    `insert into delivery_providers(id,provider_key,name,partner_organization_id,status) values($1,$2,'Simulated Courier',$3,'active')`,
    [provider, provider, org]);
  await sql.query(`insert into partner_organization_users(organization_id,user_id,role,status) values($1,$2,'rider','active')`, [org, rider]);
  // The rider accepted an individual invitation for the rider capability.
  await sql.query(
    `insert into provider_rider_invitations(id,organization_id,invited_email,full_name,mobile_phone,rider_type,status,created_by,
                                            accepted_by,accepted_at,expires_at,capability)
     values($1,$2,$3,'Simulated Rider',$4,'contractor','accepted','simulation',$5,$6::timestamptz - interval '1 day',
            $6::timestamptz + interval '6 days','rider')`,
    [id("rinv"), org, `${rider}@rider.test`, `+2335${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, rider, T]);
  await sql.query(
    `insert into delivery_personnel_capabilities(organization_id,user_id,capability,status,accepted_at,granted_by)
     values($1,$2,'rider','active',$3::timestamptz - interval '1 day','simulation')`, [org, rider, T]);

  await sql.query(`insert into delivery_jobs(id,order_id,provider_id,status,handover_kind) values($1,$2,$3,'assigned','delivery')`, [job, orderId, provider]);
  await sql.query(`update delivery_jobs set handover_rider_user_id=$2 where id=$1`, [job, rider]);
  for (const next of ["accepted", "picked_up", "in_transit"])
    await sql.query(`update delivery_jobs set status=$2 where id=$1`, [job, next]);

  await sql.query(
    `insert into otp_challenges(id,user_id,destination,purpose,provider,status,expires_at,attempts,max_attempts,cooldown_until,verified_at)
     values($1,$2,$3,'delivery_handover','elemarket_delivery','verified',$4::timestamptz + interval '5 minutes',1,5,$4::timestamptz,$4::timestamptz)`,
    [challenge, order.user_id, order.delivery_contact_phone, T]);
  await sql.query(
    `insert into delivery_otp_verifiers(challenge_id,order_id,job_id,rider_user_id,mac_hex,consumed_at)
     values($1,$2,$3,$4,$5,$6::timestamptz)`, [challenge, orderId, job, rider, "0".repeat(64), T]);
  await sql.query(
    `insert into order_delivery_handover(order_id,job_id,challenge_id,issued_at,initiated_by,verified_at,verified_by)
     values($1,$2,$3,$4::timestamptz - interval '1 minute',$5,$4::timestamptz,$5)`, [orderId, job, challenge, T, rider]);
  await sql.query(`update delivery_jobs set status='delivered', delivered_at=$2::timestamptz where id=$1`, [job, T]);
  await sql.query(
    `update orders set status='delivered', delivery_confirmation_source='delivery_otp',
            customer_received_at=elemarket_order_delivered_at(id) where id=$1`, [orderId]);
  return { orderId, jobId: job, riderId: rider, challengeId: challenge, receivedAt: T };
}
