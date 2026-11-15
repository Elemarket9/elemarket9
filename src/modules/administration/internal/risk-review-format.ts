/**
 * Pure helpers for the fraud & risk review queue. No server or database
 * imports: shared by the server (queue ordering, evidence shaping) and the
 * /admin/risk page, and unit-tested directly.
 */

export const RISK_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export const RISK_STATUSES = ["open", "resolved", "dismissed"] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const RISK_DECISIONS = ["dismissed_false_positive", "confirmed_fraud", "confirmed_monitor"] as const;
export type RiskDecision = (typeof RISK_DECISIONS)[number];

export const RISK_SUBJECT_TYPES = ["customer", "merchant"] as const;
export type RiskSubjectType = (typeof RISK_SUBJECT_TYPES)[number];

/** Must match risk_flag_claim_ttl() in migration 0232 (the database enforces it). */
export const RISK_CLAIM_TTL_MINUTES = 30;
export const RISK_NOTE_MIN = 12;
export const RISK_NOTE_MAX = 2000;

/** Order statuses that still count as "open" (not yet delivered, closed or refunded). */
export const OPEN_ORDER_STATUSES = ["payment_pending", "paid", "confirmed", "fulfilling", "shipped", "disputed"] as const;

/** Mirrors risk_severity_rank() in SQL: lower is more urgent; unknown sorts last. */
export function severityRank(severity: string): number {
  const index = (RISK_SEVERITIES as readonly string[]).indexOf(severity);
  return index === -1 ? RISK_SEVERITIES.length : index;
}

/** Queue order: open first, then critical > high > medium > low, then oldest first. */
export function compareRiskFlags(
  a: { status: string; severity: string; createdAt: string; id: string },
  b: { status: string; severity: string; createdAt: string; id: string },
): number {
  const open = Number(a.status !== "open") - Number(b.status !== "open");
  if (open) return open;
  const rank = severityRank(a.severity) - severityRank(b.severity);
  if (rank) return rank;
  const age = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (age) return age;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The status a decision moves a flag to (kept consistent by a CHECK in SQL). */
export function statusForDecision(decision: RiskDecision): Exclude<RiskStatus, "open"> {
  return decision === "dismissed_false_positive" ? "dismissed" : "resolved";
}

export function isClaimActive(assignedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!assignedAt) return false;
  const at = Date.parse(assignedAt);
  return Number.isFinite(at) && at > now - RISK_CLAIM_TTL_MINUTES * 60_000;
}

/** "ama.mensah@example.com" -> "a***h@e******.com". Never returns the full address. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  const maskPart = (part: string) =>
    part.length <= 2 ? `${part[0] ?? ""}*` : `${part[0]}${"*".repeat(Math.min(part.length - 2, 6))}${part.at(-1)}`;
  return `${maskPart(local)}@${maskPart(host)}${tld}`;
}

export const RISK_DECISION_LABELS: Record<RiskDecision, string> = {
  dismissed_false_positive: "Dismissed: false positive",
  confirmed_fraud: "Confirmed: fraud",
  confirmed_monitor: "Confirmed: keep monitoring",
};

export function decisionLabel(decision: string | null | undefined): string | null {
  if (!decision) return null;
  return (RISK_DECISION_LABELS as Record<string, string>)[decision] ?? humanizeKey(decision);
}

export const RISK_FLAG_LABELS: Record<string, string> = {
  checkout_review: "Checkout needs review",
  checkout_blocked: "Checkout blocked",
  fund_release_review: "Merchant fund release needs review",
  fund_release_blocked: "Merchant fund release blocked",
  withdrawal_review: "Merchant withdrawal needs review",
};

export const RISK_REASON_LABELS: Record<string, string> = {
  checkout_velocity: "Many checkouts in 10 minutes (5+)",
  excessive_checkout_velocity: "Very many checkouts in 10 minutes (10+)",
  payment_failures: "Several failed payments in 30 minutes (3+)",
  excessive_payment_failures: "Many failed payments in 30 minutes (8+)",
  repeated_disputes: "Repeated disputes in 90 days (3+)",
  high_dispute_frequency: "Very frequent disputes in 90 days (8+)",
  new_account_high_value: "New account (under 24h) with a large order",
  high_value_checkout: "Very large checkout (GH₵ 20,000+)",
  merchant_not_active: "Merchant is not active",
  release_exceeds_provider_eligible_amount: "Requested more than the provider-held eligible amount",
  withdrawal_exceeds_available: "Requested more than the available balance",
  active_dispute_exposure: "Merchant has open disputes",
  payout_velocity: "Many payouts in 24 hours",
  release_request_velocity: "Several fund release requests in 24 hours (3+)",
  excessive_release_request_velocity: "Many fund release requests in 24 hours (6+)",
  high_value_release_request: "Very large fund release request (GH₵ 20,000+)",
  high_value_withdrawal: "Very large withdrawal (GH₵ 20,000+)",
};

export function flagCodeLabel(code: string): string {
  return RISK_FLAG_LABELS[code] ?? humanizeKey(code);
}

export function reasonLabel(code: string): string {
  return RISK_REASON_LABELS[code] ?? humanizeKey(code);
}

const EVIDENCE_LABELS: Record<string, string> = {
  reasons: "Why it was flagged",
  score: "Risk score (0-100)",
  amount: "Amount",
  currency: "Currency",
  referenceId: "Order reference",
  assessmentId: "Risk assessment",
};
const EVIDENCE_ORDER = ["reasons", "score", "amount", "currency", "referenceId", "assessmentId"];
const MAX_ENTRIES = 50;
const MAX_VALUE = 500;
const MAX_DEPTH = 3;

/** "assessmentId" / "assessment_id" -> "Assessment id". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Value";
}

function cleanText(value: string): string {
  // Plain text only: strip control characters and cap the length. The page
  // renders this as a React text node, never as HTML.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

export type RiskEvidenceEntry = { key: string; label: string; value: string };

/**
 * Flatten a flag's `evidence` JSON into ordered key/value TEXT rows. Unknown
 * shapes degrade to readable text; nothing here is ever interpreted as markup.
 */
export function formatRiskEvidence(evidence: unknown): RiskEvidenceEntry[] {
  const out: RiskEvidenceEntry[] = [];
  const push = (key: string, label: string, value: string) => {
    if (out.length < MAX_ENTRIES) out.push({ key, label, value: cleanText(value) || "—" });
  };
  const primitive = (key: string, v: unknown): string => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return key === "reasons" ? reasonLabel(v) : v;
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    return "[data]";
  };
  const walk = (path: string, label: string, leaf: string, value: unknown, depth: number) => {
    if (Array.isArray(value)) {
      if (!value.length) return push(path, label, "None");
      if (value.every((v) => v === null || typeof v !== "object")) {
        return push(path, label, value.map((v) => primitive(leaf, v)).join(", "));
      }
      if (depth >= MAX_DEPTH) return push(path, label, `[${value.length} items]`);
      value.forEach((item, i) => walk(`${path}.${i}`, `${label} ${i + 1}`, leaf, item, depth + 1));
      return;
    }
    if (value !== null && typeof value === "object") {
      if (depth >= MAX_DEPTH) return push(path, label, "[nested data]");
      const keys = Object.keys(value as Record<string, unknown>).sort();
      if (!keys.length) return push(path, label, "None");
      for (const k of keys) walk(`${path}.${k}`, `${label} › ${humanizeKey(k)}`, k, (value as Record<string, unknown>)[k], depth + 1);
      return;
    }
    push(path, label, primitive(leaf, value));
  };

  if (evidence === null || evidence === undefined) return out;
  if (typeof evidence !== "object" || Array.isArray(evidence)) {
    walk("value", "Value", "value", evidence, 0);
    return out;
  }
  const record = evidence as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => {
    const ia = EVIDENCE_ORDER.indexOf(a);
    const ib = EVIDENCE_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const key of keys) {
    const value = record[key];
    if (key === "amount" && (typeof value === "number" || typeof value === "string") && Number.isFinite(Number(value))) {
      const currency = typeof record.currency === "string" ? record.currency : "GHS";
      push(key, EVIDENCE_LABELS.amount, `${currency} ${Number(value).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      continue;
    }
    if (key === "currency" && "amount" in record) continue; // shown with the amount
    walk(key, EVIDENCE_LABELS[key] ?? humanizeKey(key), key, value, 1);
  }
  return out;
}
