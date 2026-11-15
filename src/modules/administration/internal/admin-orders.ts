import { z } from "zod";
import { normalizeGhanaPhone } from "@/modules/identity/public/auth/phone";

/**
 * Pure helpers for the admin order workspace: search-input normalization,
 * contact masking and timeline assembly. No I/O, so they are unit-tested.
 */

export const ORDER_STATUSES = [
  "payment_pending", "paid", "confirmed", "fulfilling", "shipped", "delivered",
  "completed", "cancelled", "disputed", "refund_pending", "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ADMIN_ORDER_PAGE_MAX = 50;
export const ADMIN_ORDER_PAGE_DEFAULT = 25;

/** Raw search form as it arrives from the browser (URL search params). */
export const adminOrderSearchSchema = z.object({
  orderId: z.string().max(140).optional(),
  email: z.string().max(260).optional(),
  phone: z.string().max(40).optional(),
  merchant: z.string().max(140).optional(),
  status: z.string().max(40).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(ADMIN_ORDER_PAGE_MAX).optional(),
});
export type AdminOrderSearchInput = z.infer<typeof adminOrderSearchSchema>;

export type NormalizedAdminOrderSearch = {
  orderId: string | null;
  orderSuffix: string | null;
  email: string | null;
  phone: string | null;
  merchantId: string | null;
  merchantNameLike: string | null;
  status: OrderStatus | null;
  createdFrom: string | null; // inclusive, ISO
  createdBefore: string | null; // exclusive, ISO (day after "to")
  cursor: { at: string; id: string } | null;
  limit: number;
};

export class AdminOrderSearchError extends Error {}

const blank = (value: string | undefined) => {
  const v = value?.trim();
  return v ? v : null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function parseDay(value: string, label: string): Date {
  if (!DATE.test(value)) throw new AdminOrderSearchError(`${label} must be a date (YYYY-MM-DD)`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new AdminOrderSearchError(`${label} is not a real date`);
  return d;
}

/** Escape LIKE wildcards so "50%_off" is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Turn the free-form search form into exact, index-friendly filters.
 * Throws AdminOrderSearchError with a plain-language message on bad input.
 * Order ID (Ghana is UTC+0, so calendar days are UTC days):
 * - 8 characters  -> matches the last 8 characters of the order ID
 * - longer        -> exact full order ID
 */
export function normalizeAdminOrderSearch(raw: AdminOrderSearchInput): NormalizedAdminOrderSearch {
  const input = adminOrderSearchSchema.parse(raw);
  let orderId: string | null = null;
  let orderSuffix: string | null = null;
  const rawOrder = blank(input.orderId)?.replace(/^#/, "").trim() ?? null;
  if (rawOrder) {
    if (!/^[A-Za-z0-9_-]+$/.test(rawOrder)) throw new AdminOrderSearchError("Order ID can only contain letters, numbers, - and _");
    if (rawOrder.length === 8) orderSuffix = rawOrder;
    else if (rawOrder.length > 8 && rawOrder.length <= 128) orderId = rawOrder;
    else throw new AdminOrderSearchError("Enter the full order ID or its last 8 characters");
  }

  let email: string | null = null;
  const rawEmail = blank(input.email);
  if (rawEmail) {
    email = rawEmail.toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AdminOrderSearchError("Enter a full email address");
  }

  let phone: string | null = null;
  const rawPhone = blank(input.phone);
  if (rawPhone) {
    try { phone = normalizeGhanaPhone(rawPhone.replace(/[\s().-]/g, "")); }
    catch { throw new AdminOrderSearchError("Enter a full Ghana mobile number, e.g. 024 123 4567"); }
  }

  let merchantId: string | null = null;
  let merchantNameLike: string | null = null;
  const rawMerchant = blank(input.merchant);
  if (rawMerchant) {
    if (rawMerchant.length < 2 || rawMerchant.length > 120) throw new AdminOrderSearchError("Merchant search needs 2-120 characters");
    merchantId = rawMerchant;
    merchantNameLike = `%${escapeLike(rawMerchant)}%`;
  }

  let status: OrderStatus | null = null;
  const rawStatus = blank(input.status);
  if (rawStatus) {
    if (!(ORDER_STATUSES as readonly string[]).includes(rawStatus)) throw new AdminOrderSearchError("Unknown order status");
    status = rawStatus as OrderStatus;
  }

  const fromDay = blank(input.from);
  const toDay = blank(input.to);
  const from = fromDay ? parseDay(fromDay, "From date") : null;
  const to = toDay ? parseDay(toDay, "To date") : null;
  if (from && to && from > to) throw new AdminOrderSearchError("From date must be on or before To date");
  const before = to ? new Date(to.getTime() + 86_400_000) : null;

  let cursor: NormalizedAdminOrderSearch["cursor"] = null;
  const rawCursor = blank(input.cursor);
  if (rawCursor) {
    const pipe = rawCursor.lastIndexOf("|");
    const at = rawCursor.slice(0, pipe);
    const id = rawCursor.slice(pipe + 1);
    if (pipe <= 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(at) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new AdminOrderSearchError("Invalid page link; start the search again");
    }
    cursor = { at, id };
  }

  return {
    orderId, orderSuffix, email, phone, merchantId, merchantNameLike, status,
    createdFrom: from ? from.toISOString() : null,
    createdBefore: before ? before.toISOString() : null,
    cursor,
    limit: Math.min(input.limit ?? ADMIN_ORDER_PAGE_DEFAULT, ADMIN_ORDER_PAGE_MAX),
  };
}

/** k***a@example.com : enough to confirm with a caller, not enough to harvest. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.length <= 2 ? local[0] : `${local[0]}•••${local[local.length - 1]}`;
  return `${shown}${local.length <= 2 ? "•••" : ""}@${domain}`;
}

/** +233•••••4567 : country code and last 4 digits only. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\s+/g, "");
  if (digits.length <= 6) return "•••";
  const head = digits.startsWith("+233") ? "+233" : digits.slice(0, 2);
  return `${head}${"•".repeat(Math.max(3, digits.length - head.length - 4))}${digits.slice(-4)}`;
}

// ---- Timeline -----------------------------------------------------------------

export type TimelineKind =
  | "order" | "status" | "payment" | "refund" | "return" | "delivery" | "handover"
  | "hold" | "wallet" | "audit" | "note" | "dispute" | "shipment";

export type OrderTimelineEntry = { at: string; kind: TimelineKind; title: string; detail: string | null; actor: string | null };

type When = string | Date | null | undefined;

export type OrderTimelineSources = {
  order: { createdAt: When; status: string };
  statusHistory: Array<{ at: When; fromStatus: string | null; toStatus: string; note: string | null; actor: string | null }>;
  payments: Array<{ id: string; at: When; method: string; status: string; amount: string }>;
  paymentTransitions: Array<{ at: When; fromStatus: string | null; toStatus: string; source: string | null }>;
  paymentAttempts: Array<{ at: When; attemptNo: number; status: string; providerKey: string; failureCode: string | null }>;
  refunds: Array<{ requestedAt: When; processedAt: When; status: string; amount: string; reason: string | null; requestedBy: string | null }>;
  returns: Array<{ at: When; receivedAt: When; closedAt: When; status: string; reasonCode: string; quantity: number; resolutionType: string | null }>;
  deliveryJobs: Array<{
    providerName: string | null; status: string; failureReason: string | null; assignedAt: When; acceptedAt: When; pickedUpAt: When;
    inTransitAt: When; deliveredAt: When; failedAt: When; returnRequestedAt: When; returnedAt: When;
  }>;
  handovers: Array<{ verifiedAt: When; method: string | null; verifiedBy: string | null }>;
  holds: Array<{ placedAt: When; reason: string; placedBy: string | null; releasedAt: When; releaseReason: string | null; releasedBy: string | null; active: boolean }>;
  shipments: Array<{ shippedAt: When; deliveredAt: When; carrier: string | null; status: string }>;
  disputes: Array<{ at: When; status: string; resolvedAt: When }>;
  wallet: Array<{ at: When; entryType: string; bucket: string; amount: string }>;
  audit: Array<{ at: When; eventType: string; actor: string | null; outcome: string; reason: string | null }>;
  notes: Array<{ at: When; body: string; actor: string | null }>;
};

const words = (v: string) => v.replaceAll("_", " ");
const ghs = (v: string) => `GH₵ ${Number(v).toFixed(2)}`;

function iso(v: When): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Merge every source into one chronological, read-only list (oldest first). */
export function buildOrderTimeline(s: OrderTimelineSources): OrderTimelineEntry[] {
  const out: OrderTimelineEntry[] = [];
  const push = (at: When, kind: TimelineKind, title: string, detail: string | null = null, actor: string | null = null) => {
    const when = iso(at);
    if (when) out.push({ at: when, kind, title, detail, actor });
  };
  push(s.order.createdAt, "order", "Order placed");
  for (const h of s.statusHistory) push(h.at, "status", `Status: ${h.fromStatus ? `${words(h.fromStatus)} → ` : ""}${words(h.toStatus)}`, h.note, h.actor);
  for (const p of s.payments) push(p.at, "payment", `Payment created (${words(p.method)}, ${ghs(p.amount)})`, `Current payment status: ${words(p.status)}`);
  for (const t of s.paymentTransitions) push(t.at, "payment", `Payment: ${t.fromStatus ? `${words(t.fromStatus)} → ` : ""}${words(t.toStatus)}`, t.source ? `Source: ${words(t.source)}` : null);
  for (const a of s.paymentAttempts) push(a.at, "payment", `Payment attempt #${a.attemptNo} (${words(a.status)})`, a.failureCode ? `Failure: ${a.failureCode}` : `Provider: ${a.providerKey}`);
  for (const r of s.refunds) {
    push(r.requestedAt, "refund", `Refund requested (${ghs(r.amount)})`, [r.reason ? `Reason: ${words(r.reason)}` : null, `Status: ${words(r.status)}`].filter(Boolean).join(" · "), r.requestedBy);
    if (r.processedAt) push(r.processedAt, "refund", `Refund ${words(r.status)}`, ghs(r.amount));
  }
  for (const r of s.returns) {
    push(r.at, "return", `Return requested (${words(r.reasonCode)}, qty ${r.quantity})`, `Status: ${words(r.status)}${r.resolutionType ? ` · ${words(r.resolutionType)}` : ""}`);
    push(r.receivedAt, "return", "Returned item received");
    push(r.closedAt, "return", `Return closed (${words(r.status)})`);
  }
  for (const j of s.deliveryJobs) {
    const by = j.providerName;
    push(j.assignedAt, "delivery", "Delivery assigned", by ? `Provider: ${by}` : null);
    push(j.acceptedAt, "delivery", "Delivery accepted by provider", by);
    push(j.pickedUpAt, "delivery", "Picked up from merchant", by);
    push(j.inTransitAt, "delivery", "In transit", by);
    push(j.deliveredAt, "delivery", "Delivered (provider report)", by);
    push(j.failedAt, "delivery", "Delivery failed", j.failureReason);
    push(j.returnRequestedAt, "delivery", "Return to merchant requested", by);
    push(j.returnedAt, "delivery", "Returned to merchant", by);
  }
  for (const h of s.handovers) push(h.verifiedAt, "handover", "Handover verified with customer", h.method ? `Method: ${words(h.method)}` : null, h.verifiedBy);
  for (const h of s.holds) {
    push(h.placedAt, "hold", "Delivery hold placed", h.reason, h.placedBy);
    if (!h.active) push(h.releasedAt, "hold", "Delivery hold released", h.releaseReason, h.releasedBy);
  }
  for (const sh of s.shipments) {
    push(sh.shippedAt, "shipment", "Shipment dispatched", sh.carrier ? `Carrier: ${sh.carrier}` : null);
    push(sh.deliveredAt, "shipment", "Shipment delivered", `Status: ${words(sh.status)}`);
  }
  for (const d of s.disputes) {
    push(d.at, "dispute", "Customer opened a dispute", `Status: ${words(d.status)}`);
    push(d.resolvedAt, "dispute", `Dispute ${words(d.status)}`);
  }
  for (const w of s.wallet) push(w.at, "wallet", `Merchant wallet: ${words(w.entryType)} (${w.bucket})`, ghs(w.amount));
  for (const a of s.audit) push(a.at, "audit", a.eventType, [a.outcome !== "success" ? `Outcome: ${a.outcome}` : null, a.reason].filter(Boolean).join(" · ") || null, a.actor);
  for (const n of s.notes) push(n.at, "note", "Internal note", n.body, n.actor);
  // Stable: equal timestamps keep source order (order placed first).
  return out.map((e, i) => ({ e, i })).sort((a, b) => a.e.at.localeCompare(b.e.at) || a.i - b.i).map(({ e }) => e);
}

/** What the workspace offers for an order. The server re-checks everything. */
export function orderActionAvailability(o: { status: string; paymentStatus: string | null; holdActive: boolean }) {
  return {
    cancelUnpaid: o.status === "payment_pending",
    requestRefund: o.paymentStatus === "completed" && !["refund_pending", "refunded"].includes(o.status),
    placeHold: !o.holdActive && ["paid", "confirmed", "fulfilling", "shipped"].includes(o.status),
    releaseHold: o.holdActive,
  };
}
