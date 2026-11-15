import { getSql } from "@/lib/db";

const PAGE_SIZE = 50;
const MAX_CSV_ROWS = 5_000;

export type WalletHistoryFilter = {
  merchantId: string;
  kind: "ledger" | "payouts";
  page: number;
  dateFrom?: string;
  dateTo?: string;
};

function dates(filter: { dateFrom?: string; dateTo?: string }) {
  const from = filter.dateFrom ?? null;
  const to = filter.dateTo ?? null;
  if (from && to && from > to) throw new Error("Start date must not follow end date");
  return [from, to] as const;
}

/** Read-only, merchant-scoped, bounded pages. No bank account numbers or secrets. */
export async function loadWalletHistory(input: WalletHistoryFilter) {
  const sql = await getSql();
  const [from, to] = dates(input);
  const page = Math.max(1, Math.min(Math.floor(input.page), 1_000));
  const offset = (page - 1) * PAGE_SIZE;
  if (input.kind === "ledger") {
    const rows = await sql.query<{
      id: string; entry_type: string; bucket: string; amount: string;
      order_id: string | null; payout_id: string | null; created_at: string;
    }>(
      `select id::text, entry_type, bucket, amount::text, order_id, payout_id, created_at::text
         from wallet_ledger_entries
        where merchant_id=$1
          and ($2::date is null or (created_at at time zone 'UTC')::date >= $2::date)
          and ($3::date is null or (created_at at time zone 'UTC')::date <= $3::date)
        order by id desc limit $4 offset $5`,
      [input.merchantId, from, to, PAGE_SIZE + 1, offset]);
    return { kind: "ledger" as const, page, hasMore: rows.length > PAGE_SIZE, rows: rows.slice(0, PAGE_SIZE) };
  }
  const rows = await sql.query<{
    id: string; amount: string; net_amount: string; fee: string; status: string;
    rail: string; display_hint: string | null; provider_reference: string | null;
    created_at: string; completed_at: string | null;
  }>(
    `select w.id, w.amount::text, w.net_amount::text, w.fee::text, w.status,
            w.rail, a.display_hint, w.provider_reference, w.created_at::text, w.completed_at::text
       from wallet_payouts w join merchant_payout_accounts a on a.id=w.destination_id
      where w.merchant_id=$1
        and ($2::date is null or (w.created_at at time zone 'UTC')::date >= $2::date)
        and ($3::date is null or (w.created_at at time zone 'UTC')::date <= $3::date)
      order by w.created_at desc, w.id desc limit $4 offset $5`,
    [input.merchantId, from, to, PAGE_SIZE + 1, offset]);
  return { kind: "payouts" as const, page, hasMore: rows.length > PAGE_SIZE, rows: rows.slice(0, PAGE_SIZE) };
}

function csvCell(value: string | number | null): string {
  const raw = String(value ?? "");
  // Prevent formula injection when downloaded statements are opened in Excel.
  const safe = /^[\s]*[=+@-]/.test(raw) ? "'" + raw : raw;
  return '"' + safe.replaceAll('"', '""') + '"';
}

/** Export a clearly scoped ledger extract; never return silent partial statements. */
export async function exportWalletLedger(input: {
  merchantId: string; dateFrom: string; dateTo: string;
}) {
  const [from, to] = dates(input);
  if (!from || !to) throw new Error("Choose a start date and end date");
  const start = Date.parse(from + "T00:00:00Z");
  const end = Date.parse(to + "T00:00:00Z");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 92 * 86_400_000)
    throw new Error("Choose a date range of 93 days or fewer");
  if (new Date(start).toISOString().slice(0, 10) !== from || new Date(end).toISOString().slice(0, 10) !== to)
    throw new Error("Invalid statement dates");

  const sql = await getSql();
  const rows = await sql.query<{
    id: string; entry_type: string; bucket: string; amount: string;
    order_id: string | null; payout_id: string | null; created_at: string;
  }>(
    `select id::text, entry_type, bucket, amount::text, order_id, payout_id,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
       from wallet_ledger_entries where merchant_id=$1
        and (created_at at time zone 'UTC')::date between $2::date and $3::date
      order by id asc limit $4`,
    [input.merchantId, from, to, MAX_CSV_ROWS + 1]);
  if (rows.length > MAX_CSV_ROWS)
    throw new Error("Too many ledger entries for one export. Select a shorter date range.");
  const columns = ["UTC timestamp", "Entry ID", "Event", "Balance bucket", "Signed amount GHS", "Order ID", "Payout ID"];
  const csv = [columns.map(csvCell).join(","),
    ...rows.map((r) => [r.created_at, r.id, r.entry_type, r.bucket, r.amount, r.order_id, r.payout_id].map(csvCell).join(","))]
    .join("\r\n") + "\r\n";
  return { filename: `elemarket-wallet-ledger-${from}-to-${to}.csv`, csv, count: rows.length };
}
