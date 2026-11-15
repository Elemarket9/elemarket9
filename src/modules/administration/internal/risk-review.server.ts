import { getSql, withTransaction, type Sql } from "@/lib/db";
import {
  OPEN_ORDER_STATUSES,
  RISK_NOTE_MAX,
  RISK_NOTE_MIN,
  formatRiskEvidence,
  maskEmail,
  statusForDecision,
  type RiskDecision,
  type RiskEvidenceEntry,
  type RiskSeverity,
  type RiskSubjectType,
} from "./risk-review-format";

/**
 * Fraud & risk review queue (migration 0225).
 *
 * Reviewers claim a flag (30-minute claim, enforced by the database), then
 * dismiss it as a false positive or confirm it (fraud / keep monitoring) with
 * a mandatory note. A decision is a RECORD ONLY: it never suspends a customer
 * or merchant and never holds an order. Suspension stays with the existing
 * moderation functions and their own permissions.
 *
 * Callers (server functions) must already have checked admin.risk.review,
 * a fresh session and the rate limit. Every mutation here writes its audit
 * row in the same transaction as the change.
 */

export type RiskQueueStatusFilter = "open" | "resolved" | "dismissed" | "decided" | "all";

export type RiskQueueFilters = {
  status?: RiskQueueStatusFilter;
  severity?: RiskSeverity | null;
  subjectType?: RiskSubjectType | null;
  flagCode?: string | null;
  limit?: number;
};

export type RiskFlagSummary = {
  id: string;
  subjectType: RiskSubjectType;
  subjectId: string;
  flagCode: string;
  severity: RiskSeverity;
  status: "open" | "resolved" | "dismissed";
  decision: RiskDecision | null;
  createdAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  assignedTo: string | null;
  assigneeName: string | null;
  assignedAt: string | null;
  claimActive: boolean;
  claimExpiresAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolverName: string | null;
  resolutionNote: string | null;
  subject: {
    name: string | null;
    /** Customers only; always masked. */
    maskedEmail: string | null;
    /** Customer moderation status or merchant status. */
    status: string | null;
  };
  related: {
    /** Customer: their open orders. Merchant: open orders they must fulfil. */
    openOrders: number;
    /** Other open flags on the same subject. */
    otherOpenFlags: number;
  };
};

export type RiskFlagDetail = RiskFlagSummary & {
  evidence: RiskEvidenceEntry[];
  latestEvidence: RiskEvidenceEntry[] | null;
  openOrders: Array<{ id: string; status: string; grandTotal: string; createdAt: string; merchantName: string | null }>;
  otherFlags: Array<{ id: string; flagCode: string; severity: string; status: string; decision: string | null; createdAt: string }>;
  history: Array<{ eventType: string; actorId: string | null; actorName: string | null; at: string }>;
};

const iso = (col: string) => `to_char((${col}) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const OPEN_ORDERS = [...OPEN_ORDER_STATUSES];

type Row = {
  id: string; subject_type: RiskSubjectType; subject_id: string; flag_code: string; severity: RiskSeverity;
  status: RiskFlagSummary["status"]; decision: RiskDecision | null; created_at: string; last_seen_at: string;
  occurrence_count: number; assigned_to: string | null; assignee_name: string | null; assigned_at: string | null;
  claim_active: boolean; claim_expires_at: string | null; resolved_at: string | null; resolved_by: string | null;
  resolver_name: string | null; resolution_note: string | null; customer_name: string | null; customer_email: string | null;
  customer_status: string | null; merchant_name: string | null; merchant_status: string | null;
  open_orders: number; other_open_flags: number; evidence?: unknown; latest_evidence?: unknown;
};

/**
 * One round trip: the page of flags, subject summaries and related counts
 * are computed set-wise (grouped aggregates over the page), never per row.
 */
function queueSql(where: string, order: string, limitParam: string, extraColumns = "") {
  return `
    with page as (
      select f.* from risk_flags f
       where ${where}
       order by ${order}
       limit ${limitParam}
    ),
    customer_orders as (
      select o.user_id as subject_id, count(*)::int as n from orders o
       where o.user_id in (select subject_id from page where subject_type='customer')
         and o.status = any($1::text[])
       group by o.user_id
    ),
    merchant_orders as (
      select o.merchant_id as subject_id, count(*)::int as n from orders o
       where o.merchant_id in (select subject_id from page where subject_type='merchant')
         and o.status = any($1::text[])
       group by o.merchant_id
    ),
    subject_flags as (
      select f.subject_type, f.subject_id, count(*)::int as n from risk_flags f
       join (select distinct subject_type, subject_id from page) s
         on s.subject_type=f.subject_type and s.subject_id=f.subject_id
       where f.status='open'
       group by f.subject_type, f.subject_id
    )
    select p.id, p.subject_type, p.subject_id, p.flag_code, p.severity, p.status, p.decision,
           ${iso("p.created_at")} as created_at, ${iso("p.last_seen_at")} as last_seen_at, p.occurrence_count,
           p.assigned_to, a.name as assignee_name, ${iso("p.assigned_at")} as assigned_at,
           (p.assigned_at is not null and p.assigned_at > now() - risk_flag_claim_ttl()) as claim_active,
           ${iso("p.assigned_at + risk_flag_claim_ttl()")} as claim_expires_at,
           ${iso("p.resolved_at")} as resolved_at, p.resolved_by, r.name as resolver_name, p.resolution_note,
           cu.name as customer_name, cu.email as customer_email, cu."moderationStatus" as customer_status,
           m.name as merchant_name, m.status as merchant_status,
           coalesce(case p.subject_type when 'customer' then co.n else mo.n end, 0) as open_orders,
           greatest(coalesce(sf.n, 0) - case when p.status='open' then 1 else 0 end, 0) as other_open_flags
           ${extraColumns}
      from page p
      left join "user" a on a.id=p.assigned_to
      left join "user" r on r.id=p.resolved_by
      left join "user" cu on p.subject_type='customer' and cu.id=p.subject_id
      left join merchants m on p.subject_type='merchant' and m.id=p.subject_id
      left join customer_orders co on p.subject_type='customer' and co.subject_id=p.subject_id
      left join merchant_orders mo on p.subject_type='merchant' and mo.subject_id=p.subject_id
      left join subject_flags sf on sf.subject_type=p.subject_type and sf.subject_id=p.subject_id
     order by ${order.replaceAll("f.", "p.")}`;
}

function toSummary(r: Row): RiskFlagSummary {
  const customer = r.subject_type === "customer";
  return {
    id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, flagCode: r.flag_code, severity: r.severity,
    status: r.status, decision: r.decision, createdAt: r.created_at, lastSeenAt: r.last_seen_at,
    occurrenceCount: Number(r.occurrence_count), assignedTo: r.assigned_to, assigneeName: r.assignee_name,
    assignedAt: r.assigned_at, claimActive: Boolean(r.claim_active) && r.status === "open",
    claimExpiresAt: r.assigned_at ? r.claim_expires_at : null,
    resolvedAt: r.resolved_at, resolvedBy: r.resolved_by, resolverName: r.resolver_name, resolutionNote: r.resolution_note,
    subject: {
      name: customer ? r.customer_name : r.merchant_name,
      maskedEmail: customer ? maskEmail(r.customer_email) : null,
      status: customer ? r.customer_status : r.merchant_status,
    },
    related: { openOrders: Number(r.open_orders), otherOpenFlags: Number(r.other_open_flags) },
  };
}

const ORDER_BY: Record<"queue" | "history" | "all", string> = {
  queue: "risk_severity_rank(f.severity), f.created_at, f.id",
  history: "f.resolved_at desc, f.id",
  all: "(f.status<>'open'), risk_severity_rank(f.severity), f.created_at, f.id",
};

export async function listRiskFlags(filters: RiskQueueFilters = {}): Promise<RiskFlagSummary[]> {
  const status = filters.status ?? "open";
  const params: unknown[] = [OPEN_ORDERS];
  const where: string[] = [];
  if (status === "decided") where.push(`f.status<>'open'`);
  else if (status !== "all") { params.push(status); where.push(`f.status=$${params.length}`); }
  if (filters.severity) { params.push(filters.severity); where.push(`f.severity=$${params.length}`); }
  if (filters.subjectType) { params.push(filters.subjectType); where.push(`f.subject_type=$${params.length}`); }
  if (filters.flagCode) { params.push(filters.flagCode); where.push(`f.flag_code=$${params.length}`); }
  params.push(Math.min(Math.max(Math.trunc(filters.limit ?? 100), 1), 200));
  const order = status === "open" ? ORDER_BY.queue : status === "all" ? ORDER_BY.all : ORDER_BY.history;
  const sql = await getSql();
  const rows = await sql.query<Row>(queueSql(where.length ? where.join(" and ") : "true", order, `$${params.length}`), params);
  return rows.map(toSummary);
}

/** Distinct flag codes for the filter control (small, indexed). */
export async function listRiskFlagCodes(): Promise<string[]> {
  const sql = await getSql();
  const rows = await sql.query<{ flag_code: string }>(`select distinct flag_code from risk_flags order by flag_code limit 100`);
  return rows.map((r) => r.flag_code);
}

export async function getRiskFlagDetail(flagId: string): Promise<RiskFlagDetail | null> {
  const sql = await getSql();
  const [row] = await sql.query<Row>(
    queueSql("f.id=$2", ORDER_BY.queue, "1", ", p.evidence, p.latest_evidence"),
    [OPEN_ORDERS, flagId],
  );
  if (!row) return null;
  const [orders, otherFlags, history] = await Promise.all([
    row.subject_type === "customer"
      ? sql.query<{ id: string; status: string; grand_total: string; created_at: string; merchant_name: string | null }>(
        `select o.id, o.status, o.grand_total::text as grand_total, ${iso("o.created_at")} as created_at, m.name as merchant_name
           from orders o left join merchants m on m.id=o.merchant_id
          where o.user_id=$1 and o.status = any($2::text[])
          order by o.created_at desc limit 25`, [row.subject_id, OPEN_ORDERS])
      : Promise.resolve([]),
    sql.query<{ id: string; flag_code: string; severity: string; status: string; decision: string | null; created_at: string }>(
      `select id, flag_code, severity, status, decision, ${iso("created_at")} as created_at
         from risk_flags where subject_type=$1 and subject_id=$2 and id<>$3
        order by created_at desc limit 10`, [row.subject_type, row.subject_id, row.id]),
    sql.query<{ event_type: string; actor_user_id: string | null; actor_name: string | null; at: string }>(
      `select e.event_type, e.actor_user_id, u.name as actor_name, ${iso("e.created_at")} as at
         from audit_events e left join "user" u on u.id=e.actor_user_id
        where e.resource_type='risk_flag' and e.resource_id=$1
        order by e.id asc limit 100`, [row.id]),
  ]);
  return {
    ...toSummary(row),
    evidence: formatRiskEvidence(row.evidence),
    latestEvidence: row.latest_evidence ? formatRiskEvidence(row.latest_evidence) : null,
    openOrders: orders.map((o) => ({ id: o.id, status: o.status, grandTotal: o.grand_total, createdAt: o.created_at, merchantName: o.merchant_name })),
    otherFlags: otherFlags.map((f) => ({ id: f.id, flagCode: f.flag_code, severity: f.severity, status: f.status, decision: f.decision, createdAt: f.created_at })),
    history: history.map((h) => ({ eventType: h.event_type, actorId: h.actor_user_id, actorName: h.actor_name, at: h.at })),
  };
}

type Locked = {
  id: string; status: string; subject_type: string; subject_id: string; flag_code: string; severity: string;
  assigned_to: string | null; claim_active: boolean;
};

async function lockFlag(sql: Sql, flagId: string): Promise<Locked> {
  const [row] = await sql.query<Locked>(
    `select id, status, subject_type, subject_id, flag_code, severity, assigned_to,
            (assigned_at is not null and assigned_at > now() - risk_flag_claim_ttl()) as claim_active
       from risk_flags where id=$1 for update`, [flagId]);
  if (!row) throw new Error("Risk flag not found");
  if (row.status !== "open") throw new Error("This flag has already been decided");
  return row;
}

async function audit(sql: Sql, eventType: string, flagId: string, actorId: string, metadata: Record<string, unknown>) {
  await sql.query(`select record_audit_event($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
    eventType, "risk_flag", flagId, actorId, "admin", null, "success", JSON.stringify(metadata),
  ]);
}

/**
 * Claim a flag for review (or refresh your own claim). A live claim held by
 * someone else wins; an expired one can be taken over. Concurrent claims
 * serialize on the row lock, so exactly one succeeds.
 */
export async function claimRiskFlag(input: { flagId: string; actorId: string }) {
  return withTransaction(async (sql) => {
    const flag = await lockFlag(sql, input.flagId);
    if (flag.assigned_to && flag.assigned_to !== input.actorId && flag.claim_active) {
      throw new Error("Another reviewer is already working on this flag");
    }
    const takeoverFrom = flag.assigned_to && flag.assigned_to !== input.actorId ? flag.assigned_to : null;
    const [claimed] = await sql.query<{ assigned_at: string; claim_expires_at: string }>(
      `update risk_flags set assigned_to=$2, assigned_at=now() where id=$1
       returning ${iso("assigned_at")} as assigned_at, ${iso("assigned_at + risk_flag_claim_ttl()")} as claim_expires_at`,
      [flag.id, input.actorId]);
    await audit(sql, "admin.risk_flag.claimed", flag.id, input.actorId, {
      flagCode: flag.flag_code, severity: flag.severity, subjectType: flag.subject_type,
      refreshed: flag.assigned_to === input.actorId, expiredClaimTakenFrom: takeoverFrom,
    });
    return { flagId: flag.id, assignedTo: input.actorId, assignedAt: claimed.assigned_at, claimExpiresAt: claimed.claim_expires_at };
  });
}

/** Give a flag back to the queue. Only the claimer, or the Main Administrator. */
export async function releaseRiskFlag(input: { flagId: string; actorId: string; isOwner: boolean }) {
  return withTransaction(async (sql) => {
    const flag = await lockFlag(sql, input.flagId);
    if (!flag.assigned_to) throw new Error("This flag is not claimed");
    if (flag.assigned_to !== input.actorId && !input.isOwner) throw new Error("Only the reviewer who claimed this flag can release it");
    await sql.query(`update risk_flags set assigned_to=null, assigned_at=null where id=$1`, [flag.id]);
    await audit(sql, "admin.risk_flag.released", flag.id, input.actorId, {
      flagCode: flag.flag_code, releasedClaimOf: flag.assigned_to, claimWasActive: flag.claim_active,
    });
    return { flagId: flag.id, released: true as const };
  });
}

/**
 * Record a decision. Only the reviewer holding a LIVE claim may decide; the
 * Main Administrator may decide without one (recorded as an override). The
 * database enforces the same rule. Suspends nobody and holds nothing.
 */
export async function decideRiskFlag(input: {
  flagId: string; actorId: string; isOwner: boolean; decision: RiskDecision; note: string;
}) {
  const note = input.note.trim();
  if (note.length < RISK_NOTE_MIN || note.length > RISK_NOTE_MAX) {
    throw new Error(`A note of ${RISK_NOTE_MIN} to ${RISK_NOTE_MAX} characters is required`);
  }
  const status = statusForDecision(input.decision);
  return withTransaction(async (sql) => {
    const flag = await lockFlag(sql, input.flagId);
    const holdsClaim = flag.assigned_to === input.actorId && flag.claim_active;
    if (!holdsClaim && !input.isOwner) {
      throw new Error(flag.assigned_to === input.actorId
        ? "Your claim on this flag expired; claim it again before deciding"
        : "Claim this flag before deciding it");
    }
    await sql.query(
      `update risk_flags set status=$2, decision=$3, resolution_note=$4, resolved_by=$5, resolved_at=now() where id=$1`,
      [flag.id, status, input.decision, note, input.actorId]);
    await audit(sql, "admin.risk_flag.decided", flag.id, input.actorId, {
      decision: input.decision, status, flagCode: flag.flag_code, severity: flag.severity,
      subjectType: flag.subject_type, subjectId: flag.subject_id,
      ownerOverride: !holdsClaim, overriddenClaimOf: !holdsClaim && flag.claim_active ? flag.assigned_to : null,
    });
    return { flagId: flag.id, status, decision: input.decision, subjectType: flag.subject_type, subjectId: flag.subject_id };
  });
}
