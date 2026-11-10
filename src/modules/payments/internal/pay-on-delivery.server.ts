import { getSql } from "@/lib/db";
import { getPaymentAdapter } from "@/modules/payments/internal/adapters/registry";
import type { MobileMoneyNetwork } from "@/modules/payments/internal/adapters/payment";
import { createExternalPaymentIntent } from "@/modules/payments/internal/payment.server";

/**
 * Pay on delivery, payment side. The caller (rider or pickup attendant flow)
 * must already have authorized the person at the door for this order.
 *
 * Safety rules:
 *  - the prompt always goes to the order's verified contact phone;
 *  - a new prompt is never sent while an earlier one could still be approved;
 *    an older open prompt is first checked with the provider;
 *  - only the signed provider webhook completes the payment.
 */

/** A prompt is left alone this long before the provider is asked about it (networks expire prompts in about 3 minutes). */
const PROMPT_WINDOW_MS = 3 * 60 * 1000;
/** Still pending at the provider after this long: treat as abandoned. */
const PROMPT_ABANDON_MS = 10 * 60 * 1000;

/** Ghana numbering plan prefixes (after +233). */
export function ghanaMobileNetwork(phone: string): MobileMoneyNetwork {
  const match = /^\+233([25][0-9])[0-9]{7}$/.exec(phone);
  if (!match) throw new Error("A verified Ghana mobile number is required");
  const prefix = match[1];
  if (["24", "25", "53", "54", "55", "59"].includes(prefix)) return "mtn";
  if (["20", "50"].includes(prefix)) return "telecel";
  if (["26", "27", "56", "57"].includes(prefix)) return "airteltigo";
  throw new Error("This number's network does not support mobile money prompts");
}

type OrderPayment = {
  order_id: string; user_id: string; phone: string; payment_id: string; payment_status: string;
  provider_key: string; driver_key: string | null; payment_timing: string;
};

async function loadOrderPayment(orderId: string): Promise<OrderPayment> {
  const sql = await getSql();
  const [row] = await sql.query<OrderPayment>(
    `select o.id as order_id, o.user_id, o.delivery_contact_phone as phone, p.id as payment_id, p.status as payment_status,
            p.provider_key, pp.driver_key, o.payment_timing
       from orders o join payments p on p.order_id = o.id
       left join payment_providers pp on pp.provider_key = p.provider_key
      where o.id = $1 and o.delivery_contact_snapshot_verified = true`, [orderId]);
  if (!row) throw new Error("Order payment is unavailable");
  if (row.payment_timing !== "on_delivery") throw new Error("This order was paid online");
  return row;
}

export type DoorstepPaymentState =
  | { state: "paid" }
  | { state: "awaiting_customer"; needsCustomerCode: boolean; displayText: string | null }
  | { state: "confirming" }
  | { state: "prompt_sent"; needsCustomerCode: boolean; displayText: string | null };

/** Close (as failed) an open prompt the provider no longer considers payable. */
async function settleStalePrompt(row: OrderPayment): Promise<DoorstepPaymentState | null> {
  const sql = await getSql();
  const [open] = await sql.query<{ id: string; provider_reference: string | null; age_ms: number; metadata: Record<string, unknown> | null }>(
    `select id, provider_reference, (extract(epoch from now() - created_at) * 1000)::bigint as age_ms, metadata
       from payment_attempts where payment_id = $1 and status in ('initiated','pending','authorized')
      order by attempt_no desc limit 1`, [row.payment_id]);
  if (!open) return null;
  const meta = open.metadata ?? {};
  const waiting: DoorstepPaymentState = {
    state: "awaiting_customer",
    needsCustomerCode: meta.providerStatus === "send_otp",
    displayText: typeof meta.displayText === "string" ? meta.displayText : null,
  };
  if (Number(open.age_ms) < PROMPT_WINDOW_MS || !open.provider_reference) return waiting;
  const adapter = await getPaymentAdapter(row.provider_key, row.driver_key ?? undefined);
  if (!adapter.verifyTransaction) return waiting;
  let providerStatus: string;
  try {
    providerStatus = (await adapter.verifyTransaction(open.provider_reference)).status;
  } catch {
    // Unknown at the provider: it was never created there, so nothing can be approved.
    providerStatus = "not_found";
  }
  if (providerStatus === "completed") return { state: "confirming" };
  const finished = ["failed", "abandoned", "reversed", "not_found"].includes(providerStatus)
    || Number(open.age_ms) >= PROMPT_ABANDON_MS;
  if (!finished) return waiting;
  await sql.query(
    `update payment_attempts set status = 'failed', updated_at = now()
      where id = $1 and status in ('initiated','pending','authorized')`, [open.id]);
  return null;
}

/** Send (or report) the mobile money prompt for an unpaid pay-on-delivery order. */
export async function requestPayOnDeliveryPrompt(orderId: string): Promise<DoorstepPaymentState> {
  const row = await loadOrderPayment(orderId);
  if (row.payment_status === "completed") return { state: "paid" };
  if (row.payment_status !== "initiated") throw new Error("This payment can no longer be collected");
  const pending = await settleStalePrompt(row);
  if (pending) return pending;
  const result = await createExternalPaymentIntent({
    paymentId: row.payment_id,
    userId: row.user_id,
    mobileMoneyPrompt: { phone: row.phone, network: ghanaMobileNetwork(row.phone) },
  });
  if ("awaitingCustomer" in result && result.awaitingCustomer) return { state: "awaiting_customer", needsCustomerCode: false, displayText: null };
  if (result.status === "failed") throw new Error("The network declined the prompt. Ask the customer to check their wallet and try again.");
  const needsCustomerCode = "needsCustomerCode" in result && result.needsCustomerCode === true;
  const displayText = "displayText" in result && typeof result.displayText === "string" ? result.displayText : null;
  return { state: "prompt_sent", needsCustomerCode, displayText };
}

/** Telecel-style networks: pass the customer's voucher code to the provider. */
export async function submitPayOnDeliveryCode(orderId: string, code: string): Promise<DoorstepPaymentState> {
  const row = await loadOrderPayment(orderId);
  if (row.payment_status === "completed") return { state: "paid" };
  const sql = await getSql();
  const [open] = await sql.query<{ provider_reference: string | null }>(
    `select provider_reference from payment_attempts where payment_id = $1 and status in ('initiated','pending','authorized')
      order by attempt_no desc limit 1`, [row.payment_id]);
  if (!open?.provider_reference) throw new Error("Send the payment prompt first");
  const adapter = await getPaymentAdapter(row.provider_key, row.driver_key ?? undefined);
  if (!adapter.submitMobileMoneyCode) throw new Error("This provider does not take customer codes");
  const result = await adapter.submitMobileMoneyCode({ reference: open.provider_reference, code });
  return { state: "prompt_sent", needsCustomerCode: result.needsCustomerCode === true, displayText: typeof result.metadata?.displayText === "string" ? result.metadata.displayText : null };
}

/** Whether the configured mobile money provider can send prompts at all. */
export async function payOnDeliveryProviderReady(): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql.query<{ provider_key: string; driver_key: string | null }>(
    `select provider_key, driver_key from payment_providers where status='active' and method='mobile_money' order by provider_key limit 1`);
  if (!rows[0]) return false;
  try {
    const adapter = await getPaymentAdapter(rows[0].provider_key, rows[0].driver_key ?? undefined);
    return adapter.supportsMobileMoneyPrompt === true && typeof adapter.requestMobileMoneyPrompt === "function";
  } catch {
    return false;
  }
}
