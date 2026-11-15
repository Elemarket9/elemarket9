import { getSql, withTransaction, type Sql } from "@/lib/db";
import {
  getPaymentAdapter, assertPaymentInitializationReady, getPaymentCallbackOrigin,
} from "@/modules/payments/internal/adapters/registry";
import { planMultiMerchantSplit, type MarketplaceSplitOrder } from "./multi-merchant-split";
import { deterministicPaymentReference, moneyToMinorUnits } from "./payment-reference";
import { validateProviderCheckoutUrl } from "./payment.server";
import { getElemarketEnvironment } from "@/lib/env.server";
import { enforceRateLimit } from "@/lib/security/rate-limit.server";
import { requireCustomerForUserId } from "@/modules/identity/public/auth/authorization.server";

type GroupChargeRow = {
  id: string; group_id: string; user_id: string; provider_key: string;
  amount: string; method: string; status: string; currency: string;
  provider_reference: string; checkout_url: string | null;
  initiation_token: string | null; initiation_lease_until: string | null;
};
type MerchantGroupRow = {
  order_id: string; payment_id: string; merchant_id: string;
  user_id: string; payment_user_id: string;
  payment_status: string; order_status: string; payment_timing: string;
  amount: string; grand_total: string; product_total: string; delivery_total: string;
  platform_fee: string; merchant_net: string; currency: string;
  payment_currency: string; method: string; provider_key: string;
  merchant_status: string; verified: boolean;
  settlement_model: string; payment_settlement: string | null;
  subaccount: string | null;
};
const toAmount = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
function groupFeatureReady() {
  // Production activation requires explicit PSP/contract approval and verified
  // provider-side split or provider-held wallet settlement configuration.
  if (getElemarketEnvironment() === "production" &&
      process.env.ELEMARKET_GROUP_SINGLE_CHARGE_ENABLED !== "1") {
    throw new Error("Single-charge multi-merchant checkout is not enabled for this payment environment");
  }
}
async function groupRows(sql: Sql, groupId: string, userId: string, lock: boolean): Promise<MerchantGroupRow[]> {
  return sql.query<MerchantGroupRow>(`
    select o.id as order_id,p.id as payment_id,o.merchant_id,
      o.user_id,p.user_id as payment_user_id,
      p.status as payment_status,o.status as order_status,o.payment_timing,
      p.amount::text as amount,o.grand_total::text as grand_total,
      o.product_total::text as product_total,o.delivery_total::text as delivery_total,
      o.platform_fee::text as platform_fee,o.merchant_net::text as merchant_net,
      o.currency,p.currency as payment_currency,p.method,p.provider_key,
      m.status as merchant_status,m.verified,m.settlement_model,
      p.settlement_model as payment_settlement,
      (select a.provider_account_ref from merchant_payment_accounts a
        where a.merchant_id=o.merchant_id and a.provider_key=p.provider_key and a.status='active'
        order by a.created_at desc limit 1) as subaccount
    from orders o join payments p on p.order_id=o.id
    join merchants m on m.id=o.merchant_id
    where o.group_id=$1 and o.user_id=$2
    order by o.id ${lock ? "for update of o,p" : ""}`, [groupId,userId]);
}
function verifyMerchants(rows: MerchantGroupRow[]) {
  if (rows.length < 2 || rows.length > 3) throw new Error("Group checkout requires 2–3 distinct merchants");
  const method = rows[0].method, provider = rows[0].provider_key;
  const wallet = rows.every((r) => r.settlement_model === "platform_wallet");
  const direct = rows.every((r) => r.settlement_model === "provider_direct");
  if (!wallet && !direct) throw new Error("Merchants in this basket use incompatible provider settlement methods");
  const identities = new Set(rows.map((r) => r.merchant_id));
  if (identities.size !== rows.length || !provider) throw new Error("Invalid merchant group");
  for (const r of rows) {
    if (r.method !== method || r.provider_key !== provider || r.currency !== "GHS" ||
        r.payment_currency !== "GHS" || r.payment_status !== "initiated" ||
        r.order_status !== "payment_pending" || r.payment_timing !== "upfront" ||
        r.user_id !== r.payment_user_id || r.merchant_status !== "active" || !r.verified ||
        (r.payment_settlement !== null && r.payment_settlement !== (wallet ? "platform_wallet" : "provider_split")) ||
        moneyToMinorUnits(r.amount) !== moneyToMinorUnits(r.grand_total)) {
      throw new Error("A merchant order is not eligible for one secure group payment");
    }
    if (direct && !r.subaccount) throw new Error("A merchant needs a verified provider payout subaccount for one-charge checkout");
  }
  return { mode: wallet ? "platform_wallet" as const : "provider_split" as const, method, provider };
}
type Existing = { charge: GroupChargeRow; begin: false } | {
  begin: true; charge: GroupChargeRow; mode: "provider_split" | "platform_wallet";
  snapshot: Record<string, unknown>;
};

export async function startCustomerGroupPayment(input: { groupId: string; userId: string }) {
  groupFeatureReady();
  await requireCustomerForUserId(input.userId);
  await enforceRateLimit("group-checkout-init", { windowSeconds: 60, maxRequests: 8, subject: input.userId });
  if (!/^grp_[a-fA-F0-9]{32}$/.test(input.groupId)) throw new Error("Invalid checkout group");
  // Preview the adapter before any database mutation. Financial correctness is
  // opt-in per adapter, not inferred from a provider's brand or HTTP endpoint.
  const sql = await getSql();
  const initialRows = await groupRows(sql,input.groupId,input.userId,false);
  if (!initialRows.length) throw new Error("Order group not found");
  const existingBefore = await sql.query<GroupChargeRow>(
    `select * from checkout_group_charges where group_id=$1 and user_id=$2`, [input.groupId,input.userId]);
  let capability: Awaited<ReturnType<typeof getPaymentAdapter>> | null = null;
  if (!existingBefore[0]) {
    const { mode, provider, method } = verifyMerchants(initialRows);
    const providers = await sql.query<{ driver_key: string | null; requires_merchant_account: boolean }>(
      `select driver_key,requires_merchant_account from payment_providers
        where provider_key=$1 and method=$2 and status='active' limit 1`, [provider,method]);
    if (!providers[0]) throw new Error("Group payment provider is not active");
    capability = await getPaymentAdapter(provider,providers[0].driver_key ?? undefined);
    assertPaymentInitializationReady(capability,provider);
    if (mode === "provider_split" && capability.supportsMultiMerchantSplit !== true) {
      throw new Error("Payment provider does not support a single transaction across multiple sellers");
    }
  }
  const token = crypto.randomUUID();
  const decision = await withTransaction<Existing>(async (tx) => {
    const [owner] = await tx.query<{id:string}>(`select id from order_groups where id=$1 and user_id=$2 for update`,[input.groupId,input.userId]);
    if (!owner) throw new Error("Order group not found");
    const existing = await tx.query<GroupChargeRow>(
      `select * from checkout_group_charges where group_id=$1 and user_id=$2 for update`, [input.groupId,input.userId]);
    if (existing[0]) {
      if (existing[0].status === "initializing") {
        if (existing[0].initiation_lease_until && new Date(existing[0].initiation_lease_until).getTime() <= Date.now()) {
          const [changed] = await tx.query<GroupChargeRow>(
            `update checkout_group_charges set status='needs_attention',failure_reason='provider result unknown after lost initiation response',
              updated_at=now() where id=$1 and status='initializing' returning *`,[existing[0].id]);
          return { begin:false, charge:changed ?? existing[0] };
        }
      }
      return { begin:false, charge:existing[0] };
    }
    const rows = await groupRows(tx,input.groupId,input.userId,true);
    const { mode, provider, method } = verifyMerchants(rows);
    if (!capability || (mode === "provider_split" && capability.supportsMultiMerchantSplit !== true)) {
      throw new Error("Group payment provider capability changed; restart checkout");
    }
    const planned: MarketplaceSplitOrder[] = rows.map((r) => ({
      orderId:r.order_id,merchantId:r.merchant_id,providerSubaccount:r.subaccount ?? "",
      currency:r.currency,productTotal:r.product_total,deliveryTotal:r.delivery_total,
      platformFee:r.platform_fee,merchantNet:r.merchant_net,grandTotal:r.grand_total,
    }));
    const amountMinor = rows.reduce((sum,r) => sum + moneyToMinorUnits(r.amount),0);
    if (!Number.isSafeInteger(amountMinor) || amountMinor<=0) throw new Error("Invalid group payment total");
    const split = mode === "provider_split" ? planMultiMerchantSplit(planned) : null;
    if (split && split.amountMinor !== amountMinor) throw new Error("Merchant allocations do not balance");
    if (mode === "platform_wallet" && planned.some((o)=>moneyToMinorUnits(o.productTotal) !==
      moneyToMinorUnits(o.platformFee) + moneyToMinorUnits(o.merchantNet))) {
      throw new Error("Merchant wallet allocations do not balance");
    }
    const id = "gpay_" + crypto.randomUUID().replace(/-/g,"");
    const reference = deterministicPaymentReference(id);
    const snapshot = {
      version:1,groupId:input.groupId,settlementModel:mode,amount:toAmount(amountMinor),
      allocations:planned.map((r)=>({orderId:r.orderId,merchantId:r.merchantId,
        amount:r.grandTotal,merchantNet:r.merchantNet,platformFee:r.platformFee,
        deliveryTotal:r.deliveryTotal,subaccount:mode==="provider_split" ? r.providerSubaccount : null})),
      split:split ? {amountMinor:split.amountMinor,platformMinor:split.platformMinor,subaccounts:split.subaccounts} : null,
    };
    const [charge] = await tx.query<GroupChargeRow>(
      `insert into checkout_group_charges
        (id,group_id,user_id,provider_key,method,currency,amount,settlement_model,split_snapshot,
         provider_reference,status,initiation_token,initiation_lease_until)
        values($1,$2,$3,$4,$5,'GHS',$6,$7,$8::jsonb,$9,'initializing',$10,now()+interval '2 minutes')
        returning *`,
      [id,input.groupId,input.userId,provider,method,toAmount(amountMinor),mode,JSON.stringify(snapshot),reference,token]);
    for (const r of rows) {
      await tx.query(`insert into checkout_group_charge_members
       (charge_id,order_id,payment_id,merchant_id,provider_account_ref,amount,merchant_net)
       values($1,$2,$3,$4,$5,$6,$7)`,
       [id,r.order_id,r.payment_id,r.merchant_id,mode==="provider_split" ? r.subaccount : null,r.amount,r.merchant_net]);
      await tx.query(`update payments set settlement_model=$1,updated_at=now()
         where id=$2 and status='initiated' and (settlement_model is null or settlement_model=$1)`,
         [mode,r.payment_id]);
    }
    return {begin:true,charge,mode,snapshot};
  });
  if (!decision.begin) {
    const g = decision.charge;
    return {groupId:g.group_id,amount:g.amount,status:g.status,
      checkoutUrl:g.status==="pending" ? g.checkout_url : null,
      awaitingConfirmation:g.status==="needs_attention" || g.status==="initializing",
      orders:initialRows.length};
  }
  const charge = decision.charge;
  const customer = await sql.query<{email:string}>(`select email from "user" where id=$1`,[input.userId]);
  const email = customer[0]?.email?.trim();
  if (!email) throw new Error("Customer email required for secure checkout");
  const provider = await sql.query<{driver_key:string|null}>(`select driver_key from payment_providers
    where provider_key=$1 and method=$2 and status='active'`,[charge.provider_key,charge.method]);
  if (!provider[0]) throw new Error("Payment provider is no longer configured");
  const adapter = capability ?? await getPaymentAdapter(charge.provider_key,provider[0].driver_key ?? undefined);
  const callback = getPaymentCallbackOrigin();
  const callbackUrl = callback
    ? `${callback.replace(/\/$/,"")}/payment/group-return?groupId=${encodeURIComponent(charge.group_id)}`
    : undefined;
  try {
    const snapshot = decision.snapshot;
    const result = await adapter.createPayment({
      paymentId:charge.id,attemptId:charge.id,amount:charge.amount,currency:charge.currency,
      method:charge.method,customerEmail:email,idempotencyKey:charge.id,callbackUrl,
      multiMerchantSplit:decision.mode==="provider_split"
        ? snapshot.split as {amountMinor:number;platformMinor:number;subaccounts:Array<{subaccount:string;share:number}>}
        : undefined,
    });
    if (result.providerReference !== charge.provider_reference) throw new Error("Group provider reference mismatch");
    const url = validateProviderCheckoutUrl(result.checkoutUrl,charge.provider_key);
    if (!url) throw new Error("Provider did not supply a hosted group checkout link");
    const [saved] = await sql.query<GroupChargeRow>(
      `update checkout_group_charges set status='pending',checkout_url=$1,initiation_token=null,
          initiation_lease_until=null,updated_at=now()
        where id=$2 and initiation_token=$3 and status='initializing'
        returning *`,[url,charge.id,token]);
    if (!saved) {
      const [current] = await sql.query<GroupChargeRow>(`select * from checkout_group_charges where id=$1`,[charge.id]);
      if (current?.status==="completed") return {groupId:charge.group_id,status:"completed",amount:charge.amount,checkoutUrl:null,orders:initialRows.length};
      throw new Error("Group payment provider initiation requires manual reconciliation");
    }
    return {groupId:charge.group_id,status:"pending",amount:charge.amount,checkoutUrl:url,orders:initialRows.length};
  } catch (error) {
    // A lost provider response is ambiguous. Never issue a second charge.
    await sql.query(`update checkout_group_charges set status='needs_attention',
       failure_reason='unverified provider initialization; do not charge again',
       initiation_token=null,initiation_lease_until=null,updated_at=now()
       where id=$1 and initiation_token=$2 and status='initializing'`,[charge.id,token]);
    throw error;
  }
}

export async function getCustomerGroupPaymentStatus(input:{groupId:string;userId:string}) {
  await requireCustomerForUserId(input.userId);
  const sql=await getSql();
  const [charge]=await sql.query<GroupChargeRow>(
    `select * from checkout_group_charges where group_id=$1 and user_id=$2`,[input.groupId,input.userId]);
  if (!charge) throw new Error("Single-charge group checkout not found");
  const members=await sql.query<{orderId:string;status:string;amount:string}>(
    `select o.id as "orderId",o.status,p.amount::text as amount
       from checkout_group_charge_members gm
       join orders o on o.id=gm.order_id
       join payments p on p.id=gm.payment_id
      where gm.charge_id=$1 and o.user_id=$2
      order by o.id`,[charge.id,input.userId]);
  return {groupId:charge.group_id,status:charge.status,amount:charge.amount,
    checkoutUrl:charge.status==="pending" ? charge.checkout_url : null,orders:members,
    awaitingConfirmation:charge.status==="initializing" || charge.status==="needs_attention"};
}
