import { formatGhs as formatMoney } from "@/modules/shared/public/money";

/**
 * One place for how staff and customers see money, dates and masked contact
 * details. Before this, each page carried its own copy and the same customer
 * email was masked four different ways across the back office.
 */

/** "GH₵ 1,234.50"; "—" for a missing amount. One money format: delegates to shared/money. */
export function formatGhs(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return formatMoney(value);
}

/** "15 Nov 2026, 10:42"; "—" for a missing date. */
export function formatDateTime(value: string | Date | null | undefined): string {
  return value ? new Date(value).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

/** k•••h@example.com : enough to confirm with a caller, not enough to harvest. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.length <= 2 ? `${local[0]}•••` : `${local[0]}•••${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}

/**
 * The order number customers and staff say out loud: the last 8 characters,
 * upper-case ("#1JQPKATU"). Staff can search orders by exactly this.
 */
export function orderNumber(orderId: string | null | undefined): string {
  if (!orderId) return "";
  return `#${orderId.slice(-8).toUpperCase()}`;
}

/** What an order status means to a customer, in plain words, with a colour tone. */
export function orderStatusDisplay(status: string): { label: string; tone: "warn" | "ok" | "info" | "muted" } {
  const map: Record<string, { label: string; tone: "warn" | "ok" | "info" | "muted" }> = {
    payment_pending: { label: "Waiting for payment", tone: "warn" },
    paid: { label: "Paid", tone: "ok" },
    confirmed: { label: "Confirmed", tone: "ok" },
    fulfilling: { label: "Being prepared", tone: "info" },
    shipped: { label: "On the way", tone: "info" },
    delivered: { label: "Delivered", tone: "ok" },
    completed: { label: "Completed", tone: "ok" },
    cancelled: { label: "Cancelled", tone: "muted" },
    refund_pending: { label: "Refund in progress", tone: "warn" },
    refunded: { label: "Refunded", tone: "muted" },
    disputed: { label: "Problem reported", tone: "warn" },
  };
  return map[status] ?? { label: status.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()), tone: "muted" };
}

export const ORDER_TONE_CLASS: Record<"warn" | "ok" | "info" | "muted", string> = {
  warn: "bg-amber-100 text-amber-900",
  ok: "bg-green-100 text-green-800",
  info: "bg-market-soft text-market-green",
  muted: "bg-market-soft text-market-muted",
};
