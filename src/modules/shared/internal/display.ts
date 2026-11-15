/**
 * One place for how staff and customers see money, dates and masked contact
 * details. Before this, each page carried its own copy and the same customer
 * email was masked four different ways across the back office.
 */

/** "GH₵ 1,234.50"; "—" for a missing amount. */
export function formatGhs(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return `GH₵ ${Number(value).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
