// One actual marketplace group charge, two merchant orders, and a single
// signed provider webhook through every real SQL migration on in-memory PG.
import test, {before, after} from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {quoteCartCanonical} from "../src/lib/commerce-guards.mjs";
import {configureSimulationEnv,installPaymentProviderMock,seedOrder,startHarness} from "../scripts/helpers/server-harness.mjs";

configureSimulationEnv({ELEMARKET_GROUP_SINGLE_CHARGE_ENABLED:"1"});
const provider=installPaymentProviderMock();
let harness,sql,startCustomerGroupPayment,getCustomerGroupPaymentStatus,handlePaymentWebhook;
before(async()=>{
  harness=await startHarness();sql=harness.sql;
  ({startCustomerGroupPayment,getCustomerGroupPaymentStatus}=await harness.load("/src/modules/payments/public/group-checkout.server.ts"));
  ({handlePaymentWebhook}=await harness.load("/src/application/payment-webhook.server.ts"));
});
after(async()=>{provider.restore();await harness?.close();});

async function seedGroup(wallet=false){
  // Seed two genuine merchants, then release their unrelated fixture orders.
  // Never change an order's customer or quote: DB integrity rightly forbids it.
  const a=await seedOrder(sql), b=await seedOrder(sql);
  for(const s of [a,b]){
    await sql.query("select elemarket_restore_reservation_stock($1,'reserved')",[s.order]);
    await sql.query("update orders set status='cancelled' where id=$1",[s.order]);
    await sql.query("update payments set status='failed' where id=$1",[s.payment]);
  }
  if(wallet) await sql.query(
    "update merchants set settlement_model='platform_wallet' where id=any($1::text[])",
    [[a.merchant,b.merchant]]);
  const address="1 Test Street",tier="same_day";
  const lineA={productId:a.product,variantId:a.variant??null,quantity:1};
  const lineB={productId:b.product,variantId:b.variant??null,quantity:1};
  const quotes=[];
  for(const [seller,line] of [[a,lineA],[b,lineB]]){
    const quoteId="dquote_"+randomUUID().replaceAll("-","");
    const fingerprint=createHash("sha256").update(quoteCartCanonical({
      merchantId:seller.merchant,address,tier,items:[line],
    })).digest("hex");
    await sql.query(`insert into delivery_quotes
      (id,user_id,merchant_id,fingerprint,tier,price,eta_minutes,distance_km,dest_address,expires_at)
      values($1,$2,$3,$4,'same_day',15,60,1,$5,now()+interval '1 hour')`,
      [quoteId,a.user,seller.merchant,fingerprint,address]);
    quotes.push({merchantId:seller.merchant,quoteId});
  }
  const items=[lineA,lineB],idempotencyKey="group_checkout_"+randomUUID().replaceAll("-","");
  const fingerprint=createHash("sha256").update(JSON.stringify({items,quotes,address,method:"mobile_money"})).digest("hex");
  const [{result}]=await sql.query(`with identity as (select set_config('app.user_id',$1,true) u)
    select create_pending_order($1,$2,$3,$4::jsonb,$5::jsonb,$6,'mobile_money',null) as result
    from identity`,
    [a.user,idempotencyKey,fingerprint,JSON.stringify(items),JSON.stringify(quotes),address]);
  const orderA=result.orders.find(x=>x.merchantId===a.merchant);
  const orderB=result.orders.find(x=>x.merchantId===b.merchant);
  assert.ok(orderA&&orderB,"both merchants received one authoritative pending order");
  return {a:{...a,order:orderA.orderId,payment:orderA.paymentId},
    b:{...b,order:orderB.orderId,payment:orderB.paymentId},
    groupId:result.groupId,userId:a.user};
}
async function groupState(g){
  return sql.query(`select o.id,o.status as "orderStatus",p.status as "paymentStatus",p.settlement_model as "settlement"
    from orders o join payments p on p.order_id=o.id where o.group_id=$1 order by o.id`,[g.groupId]);
}
async function sendSuccess(g){
  const [grp]=await sql.query("select provider_reference,amount::text from checkout_group_charges where group_id=$1",[g.groupId]);
  provider.pay(grp.provider_reference);
  const raw=JSON.stringify({event:"charge.success",data:{id:100011+Number(grp.amount.replace(".",""))%10000,
    reference:grp.provider_reference,amount:Math.round(Number(grp.amount)*100),currency:"GHS"}});
  const answer=await handlePaymentWebhook({providerKey:"paystack",rawBody:raw,signature:provider.sign(raw)});
  return {answer,raw,ref:grp.provider_reference};
}
test("two seller orders are paid with one charge and one signed webhook (duplicate-safe)",async()=>{
  const g=await seedGroup();
  const initialCount=provider.initializeBodies.length;
  const intent=await startCustomerGroupPayment({groupId:g.groupId,userId:g.userId});
  assert.equal(intent.status,"pending");
  assert.equal(intent.orders,2);
  assert.match(intent.checkoutUrl,/^https:\/\/checkout\.paystack\.com\//);
  assert.equal(provider.initializeBodies.length,initialCount+1);
  const request=provider.initializeBodies.at(-1);
  assert.equal(request.split.type,"flat");
  assert.equal(request.split.subaccounts.length,2);
  assert.equal(request.split.subaccounts.reduce((s,x)=>s+x.share,0) < Number(request.amount),true);
  const repeat=await startCustomerGroupPayment({groupId:g.groupId,userId:g.userId});
  assert.equal(repeat.checkoutUrl,intent.checkoutUrl);
  assert.equal(provider.initializeBodies.length,initialCount+1,"must never charge a group twice");
  const {createExternalPaymentIntent}=await harness.load("/src/modules/payments/public/payment.server.ts");
  await assert.rejects(
    createExternalPaymentIntent({paymentId:g.a.payment,userId:g.userId}),
    /single-charge|combined checkout/,
    "group members must never also be charged separately",
  );
  assert.equal((await groupState(g)).every(x=>x.paymentStatus==="initiated"&&x.orderStatus==="payment_pending"),true);
  const {answer,raw}=await sendSuccess(g);
  assert.equal(answer.status,"completed");
  const states=await groupState(g);
  assert.equal(states.length,2);
  assert.equal(states.every(x=>x.paymentStatus==="completed"&&x.orderStatus==="paid"),true);
  assert.equal((await getCustomerGroupPaymentStatus({groupId:g.groupId,userId:g.userId})).status,"completed");
  const replay=await handlePaymentWebhook({providerKey:"paystack",rawBody:raw,signature:provider.sign(raw)});
  assert.equal(replay.duplicate,true);
  const moves=await sql.query(`select count(*)::int as n from payment_state_transitions
    where payment_id=any($1::text[]) and to_status='completed'`,[[g.a.payment,g.b.payment]]);
  assert.equal(moves[0].n,2,"one transition per merchant, not per callback");
  // There may never be N provider references/charges on N merchant orders.
  const attempts=await sql.query("select count(*)::int as n from payment_attempts where payment_id=any($1::text[])",[[g.a.payment,g.b.payment]]);
  assert.equal(attempts[0].n,0);
});

test("individual seller refund against one shared provider reference leaves other merchant paid",async()=>{
  const g=await seedGroup();
  await startCustomerGroupPayment({groupId:g.groupId,userId:g.userId});
  const {ref}=await sendSuccess(g);
  const [{result}]=await sql.query("select prepare_provider_refund_for_payment($1,$2,'customer_order_cancellation') as result",
    [g.a.payment,g.userId]);
  const requestId=result.requestId;
  const [row]=await sql.query("select amount::text,provider_reference from provider_refund_requests where id=$1",[requestId]);
  assert.equal(row.provider_reference,ref);
  const refundId="refund_sim_"+g.groupId;
  await sql.query("update provider_refund_requests set status='processing',provider_refund_id=$1 where id=$2",[refundId,requestId]);
  const raw=JSON.stringify({event:"refund.processed",data:{id:refundId,transaction_reference:ref,
    amount:Math.round(Number(row.amount)*100),currency:"GHS"}});
  const res=await handlePaymentWebhook({providerKey:"paystack",rawBody:raw,signature:provider.sign(raw)});
  assert.equal(res.status,"processed");
  const [a,b]=await sql.query("select o.id,o.status,p.status as payment_status from orders o join payments p on p.order_id=o.id where o.id=any($1::text[]) order by o.id",[[g.a.order,g.b.order]]);
  const states={[a.id]:a,[b.id]:b};
  assert.equal(states[g.a.order].status,"refunded");
  assert.equal(states[g.a.order].payment_status,"refunded");
  assert.equal(states[g.b.order].status,"paid");
  assert.equal(states[g.b.order].payment_status,"completed");
});

test("one group wallet collection credits both merchants separately exactly once",async()=>{
  const g=await seedGroup(true);
  const n=provider.initializeBodies.length;
  await startCustomerGroupPayment({groupId:g.groupId,userId:g.userId});
  assert.equal(provider.initializeBodies.length,n+1);
  assert.equal(provider.initializeBodies.at(-1).split,undefined,"wallet group must not also pay subaccounts");
  const {raw}=await sendSuccess(g);
  await handlePaymentWebhook({providerKey:"paystack",rawBody:raw,signature:provider.sign(raw)});
  const ledger=await sql.query(`select merchant_id, count(*)::int as n, sum(amount)::text as amount
    from wallet_ledger_entries where merchant_id=any($1::text[]) and entry_type='sale'
    group by merchant_id`,[[g.a.merchant,g.b.merchant]]);
  assert.equal(ledger.length,2);
  assert.equal(ledger.every(x=>x.n===1&&Number(x.amount)>0),true);
});


test("missing provider webhook reconciles one group charge without sending another payment request",async()=>{
  const g=await seedGroup();
  const count=provider.initializeBodies.length;
  await startCustomerGroupPayment({groupId:g.groupId,userId:g.userId});
  assert.equal(provider.initializeBodies.length,count+1);
  const [charge]=await sql.query(
    "select id,provider_reference from checkout_group_charges where group_id=$1",[g.groupId]);
  provider.pay(charge.provider_reference);
  // Simulate an authorized PSP charge whose callback never reaches ELEMARKET.
  await sql.query(
    "update checkout_group_charges set updated_at=now()-interval '10 minutes' where id=$1",[charge.id]);
  const {reconcileStaleGroupCharges}=await harness.load("/src/modules/payments/public/reconciliation.server.ts");
  const result=await reconcileStaleGroupCharges(20);
  assert.ok(result.settled>=1,"provider read-back must settle the real merchant group");
  assert.equal(provider.initializeBodies.length,count+1,"reconciliation must never create another charge");
  const rows=await groupState(g);
  assert.equal(rows.every(x=>x.paymentStatus==="completed"&&x.orderStatus==="paid"),true);
});

test("a definitively failed group payment cancels every merchant order and releases reservations",async()=>{
  const g=await seedGroup();
  await startCustomerGroupPayment({groupId:g.groupId,userId:g.userId});
  const [charge]=await sql.query("select provider_reference,amount::text from checkout_group_charges where group_id=$1",[g.groupId]);
  const raw=JSON.stringify({event:"charge.failed",data:{
    id:200011+Number(charge.amount.replace(".",""))%10000,
    reference:charge.provider_reference,amount:Math.round(Number(charge.amount)*100),currency:"GHS"}});
  const result=await handlePaymentWebhook({providerKey:"paystack",rawBody:raw,signature:provider.sign(raw)});
  assert.equal(result.status,"failed");
  const statuses=await groupState(g);
  assert.equal(statuses.every(x=>x.orderStatus==="cancelled"&&x.paymentStatus==="failed"),true);
});
