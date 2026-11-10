// Pickup at checkout on REAL PostgreSQL (migration 0219): pickup quotes are
// bound to a pickup point the delivery company runs, the real dispatcher creates
// a pickup job for that point, the attendant's OTP handover completes the order,
// and the wallet hold starts from that handover.
// Run: RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://…/<name>_test npm run test:db:postgres
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";
import { configureSimulationEnv, installPaymentProviderMock, seedOrder, startHarness } from "../scripts/helpers/server-harness.mjs";
import { quoteCartCanonical } from "../src/lib/commerce-guards.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "PostgreSQL integration not enabled (RUN_DB_INTEGRATION=1, ELEMARKET_INTEGRATION_DATABASE_URL=…_test)";
const PROVIDER_KEY = "pickupsim";
let db, harness, sql, payments, handlePaymentWebhook, provider, delivery, dispatch, event = 95_000;
const id = (p) => `${p}_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  configureSimulationEnv({ DATABASE_URL: db.url, ELEMARKET_DELIVERY_PROVIDER: PROVIDER_KEY });
  provider = installPaymentProviderMock();
  harness = await startHarness();
  sql = harness.sql;
  payments = await harness.load("/src/modules/payments/public/payment.server.ts");
  ({ handlePaymentWebhook } = await harness.load("/src/application/payment-webhook.server.ts"));
  delivery = await harness.load("/src/modules/logistics/internal/adapters/delivery.server.ts");
  dispatch = await harness.load("/src/modules/logistics/internal/dispatch.server.ts");
});
after(async () => {
  if (!enabled) return;
  provider?.restore();
  await harness?.close();
  await db?.drop();
});

/** A delivery company with one pickup point and an accepted attendant there. */
async function deliveryCompany({ key = id("courier"), withAttendant = true } = {}) {
  const org = id("porg"), prov = id("dprov"), location = id("pickup"), attendant = id("attendant");
  await sql.query(`insert into partner_organizations(id,name,status) values($1,'Simulated Courier Co','active')`, [org]);
  await sql.query(`insert into delivery_providers(id,provider_key,name,partner_organization_id,status) values($1,$2,'Simulated Courier',$3,'active')`, [prov, key, org]);
  await sql.query(
    `insert into pickup_locations(id,organization_id,name,address,contact_phone,latitude,longitude,created_by)
     values($1,$2,'Osu Pickup Point','12 Oxford Street, Osu, Accra','+233241234567',5.556,-0.182,'simulation')`, [location, org]);
  if (withAttendant) {
    await sql.query(`insert into "user"(id,name,email,"emailVerified") values($1,'Simulated Attendant',$2,true)`, [attendant, `${attendant}@pickup.test`]);
    await sql.query(`insert into partner_organization_users(organization_id,user_id,role,status) values($1,$2,'operator','active')`, [org, attendant]);
    await sql.query(
      `insert into provider_rider_invitations(id,organization_id,invited_email,full_name,mobile_phone,rider_type,status,created_by,
                                              accepted_by,accepted_at,expires_at,capability,pickup_location_id)
       values($1,$2,$3,'Simulated Attendant','+233559876543','employee','accepted','simulation',$4,now()-interval '1 day',now()+interval '6 days','pickup_attendant',$5)`,
      [id("inv"), org, `${attendant}@pickup.test`, attendant, location]);
    await sql.query(
      `insert into delivery_personnel_capabilities(organization_id,user_id,capability,status,accepted_at,granted_by)
       values($1,$2,'pickup_attendant','active',now()-interval '1 day','simulation')`, [org, attendant]);
    await sql.query(`insert into pickup_location_attendants(organization_id,location_id,user_id,status) values($1,$2,$3,'active')`, [org, location, attendant]);
  }
  return { org, provider: prov, location, attendant };
}

/** A paid order whose purchased quote is for `pickupLocationId` (or door delivery when null). */
async function paidOrder(seed, company, pickupLocationId) {
  const [loc] = pickupLocationId ? await sql.query(`select address from pickup_locations where id=$1`, [pickupLocationId]) : [{ address: "1 Test Street, Accra" }];
  const items = [{ productId: seed.product, variantId: seed.variant, quantity: 1 }];
  const quoteId = id("dq");
  const fingerprint = createHash("sha256").update(quoteCartCanonical({ merchantId: seed.merchant, address: loc.address, tier: "next_day", items })).digest("hex");
  await sql.query(
    `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,expires_at,provider_id,pickup_location_id)
     values($1,$2,$3,$4,'next_day',9,1440,2,$5,now()+interval '1 hour',$6,$7)`,
    [quoteId, seed.user, seed.merchant, fingerprint, loc.address, company.provider, pickupLocationId]);
  const tag = randomBytes(4).toString("hex");
  const [{ result }] = await sql.query(
    `with identity as (select set_config('app.user_id',$1,true) u)
     select create_pending_order($1,$2,$3,$4::jsonb,$5::jsonb,$6,'mobile_money',null) as result from identity`,
    [seed.user, `pick_${tag}_0123456789`, createHash("sha256").update(tag).digest("hex"), JSON.stringify(items),
      JSON.stringify([{ merchantId: seed.merchant, quoteId }]), loc.address]);
  const order = result.orders[0];
  const intent = await payments.createExternalPaymentIntent({ paymentId: order.paymentId, userId: seed.user });
  provider.pay(intent.providerReference);
  const raw = JSON.stringify({ event: "charge.success", data: { id: event++, reference: intent.providerReference, amount: Math.round(Number(order.grandTotal) * 100), currency: "GHS" } });
  await handlePaymentWebhook({ providerKey: "paystack", rawBody: raw, signature: provider.sign(raw) });
  return order;
}
async function shop() {
  const seed = await seedOrder(sql);
  await sql.query(`update orders set status='cancelled' where id=$1`, [seed.order]);
  await sql.query(`update product_variants set stock=100 where id=$1`, [seed.variant]);
  await sql.query(`update products set stock=100 where id=$1`, [seed.product]);
  return seed;
}

let company;
test("checkout lists only staffed pickup points of the configured delivery company", { skip }, async () => {
  company = await deliveryCompany({ key: PROVIDER_KEY });
  const unstaffed = await deliveryCompany({ withAttendant: false });
  const other = await deliveryCompany();
  const ids = (await delivery.listCheckoutPickupLocationsServer()).map((l) => l.id);
  assert.ok(ids.includes(company.location));
  assert.ok(!ids.includes(unstaffed.location), "no attendant: not offered");
  assert.ok(!ids.includes(other.location), "another company's point: not offered");
});

test("a pickup quote must be for that company's point and addressed to it", { skip }, async () => {
  const seed = await shop();
  const other = await deliveryCompany();
  const insert = (location, address, prov = company.provider) => sql.query(
    `insert into delivery_quotes(id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,expires_at,provider_id,pickup_location_id)
     values($1,$2,$3,$4,'next_day',9,1440,2,$5,now()+interval '1 hour',$6,$7)`,
    [id("dq"), seed.user, seed.merchant, "a".repeat(64), address, prov, location]);
  await assert.rejects(insert(other.location, "12 Oxford Street, Osu, Accra"), /not served by this delivery company/);
  await assert.rejects(insert(company.location, "Somewhere else entirely, Accra"), /addressed to the pickup point/);
  await insert(company.location, "12 Oxford Street, Osu, Accra");
});

test("the dispatcher creates a pickup job at the chosen point; door orders stay door orders", { skip }, async () => {
  const seed = await shop();
  const pickupOrder = await paidOrder(seed, company, company.location);
  const doorOrder = await paidOrder(seed, company, null);
  await dispatch.dispatchDeliveries(50);
  const [pj] = await sql.query(`select handover_kind, pickup_location_id from delivery_jobs where order_id=$1`, [pickupOrder.orderId]);
  assert.deepEqual(pj, { handover_kind: "pickup", pickup_location_id: company.location });
  const [dj] = await sql.query(`select handover_kind, pickup_location_id from delivery_jobs where order_id=$1`, [doorOrder.orderId]);
  assert.deepEqual(dj, { handover_kind: "delivery", pickup_location_id: null });
});

test("a pickup order cannot be turned into door delivery, or sent to another point", { skip }, async () => {
  const seed = await shop();
  const order = await paidOrder(seed, company, company.location);
  await assert.rejects(sql.query(`insert into delivery_jobs(id,order_id,provider_id,handover_kind) values($1,$2,$3,'delivery')`,
    [id("dj"), order.orderId, company.provider]), /bought for pickup/);
  const second = await deliveryCompany();
  await assert.rejects(sql.query(`insert into delivery_jobs(id,order_id,provider_id,handover_kind,pickup_location_id) values($1,$2,$3,'pickup',$4)`,
    [id("dj"), order.orderId, second.provider, second.location]), /pickup parcel\/location\/provider mismatch/);
});

test("the attendant's OTP handover completes the order and starts the return window", { skip }, async () => {
  const seed = await shop();
  const order = await paidOrder(seed, company, company.location);
  await dispatch.dispatchDeliveries(50);
  const [job] = await sql.query(`select id from delivery_jobs where order_id=$1`, [order.orderId]);
  for (const next of ["confirmed", "fulfilling", "shipped"]) await sql.query(`update orders set status=$2 where id=$1`, [order.orderId, next]);
  await sql.query(`update delivery_jobs set handover_rider_user_id=$2 where id=$1`, [job.id, company.attendant]);
  for (const next of ["accepted", "picked_up", "in_transit"]) await sql.query(`update delivery_jobs set status=$2 where id=$1`, [job.id, next]);
  await sql.query(`update delivery_jobs set pickup_arrived_at=now(), collection_due_at=now()+interval '7 days' where id=$1`, [job.id]);
  const [o] = await sql.query(`select user_id, delivery_contact_phone from orders where id=$1`, [order.orderId]);
  const challenge = id("otpc");
  const [{ t }] = await sql.query(`select now()::text as t`);
  await sql.query(
    `insert into otp_challenges(id,user_id,destination,purpose,provider,status,expires_at,attempts,max_attempts,cooldown_until,verified_at)
     values($1,$2,$3,'delivery_handover','elemarket_delivery','verified',$4::timestamptz+interval '5 minutes',1,5,$4::timestamptz,$4::timestamptz)`, [challenge, o.user_id, o.delivery_contact_phone, t]);
  await sql.query(`insert into delivery_otp_verifiers(challenge_id,order_id,job_id,rider_user_id,mac_hex,consumed_at) values($1,$2,$3,$4,$5,$6::timestamptz)`,
    [challenge, order.orderId, job.id, company.attendant, "0".repeat(64), t]);
  await sql.query(`insert into order_delivery_handover(order_id,job_id,challenge_id,issued_at,initiated_by,verified_at,verified_by)
                   values($1,$2,$3,$5::timestamptz-interval '1 minute',$4,$5::timestamptz,$4)`, [order.orderId, job.id, challenge, company.attendant, t]);
  await sql.query(`update delivery_jobs set status='delivered', delivered_at=$2::timestamptz where id=$1`, [job.id, t]);
  await sql.query(`update orders set status='delivered', delivery_confirmation_source='delivery_otp', customer_received_at=elemarket_order_delivered_at(id) where id=$1`, [order.orderId]);
  const [r] = await sql.query(`select elemarket_order_delivered_at($1) is not null as delivered, elemarket_order_release_at($1) > now() + interval '6 days' as held`, [order.orderId]);
  assert.deepEqual(r, { delivered: true, held: true });
});
