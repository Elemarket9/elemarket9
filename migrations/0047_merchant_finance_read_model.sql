-- Merchant finance read-model hardening.
--
-- IMPORTANT: 0022 already created merchant_financial_summary with the legacy
-- column order:
--   merchant_id, merchant_name, held_amount, available_amount,
--   payout_processing, paid_out
-- PostgreSQL CREATE OR REPLACE VIEW cannot rename/reorder existing view
-- columns. New financial fields therefore MUST be appended after those
-- legacy columns. This keeps existing consumers compatible while exposing the
-- richer merchant-finance read model.

create or replace view merchant_financial_summary as
with escrow_totals as (
  select
    e.merchant_id,
    coalesce(sum(e.gross_amount), 0)::numeric(12,2) as total_sales,
    coalesce(sum(case
      when e.state in ('held','fulfilling','delivered','release_pending','disputed','refund_pending')
      then e.merchant_entitlement else 0 end
    ), 0)::numeric(12,2) as held_amount,
    coalesce(sum(case
      when e.state in ('held','fulfilling','delivered','release_pending','refund_pending')
      then e.merchant_entitlement else 0 end
    ), 0)::numeric(12,2) as pending_amount,
    coalesce(sum(case
      when e.state = 'disputed'
      then e.merchant_entitlement else 0 end
    ), 0)::numeric(12,2) as disputed_amount
  from escrows e
  group by e.merchant_id
),
settlement_totals as (
  select
    s.merchant_id,
    coalesce(sum(case when s.status='eligible' then s.amount else 0 end), 0)::numeric(12,2) as available_amount,
    coalesce(sum(case when s.status='processing' then s.amount else 0 end), 0)::numeric(12,2) as payout_processing,
    coalesce(sum(case when s.status='paid' then s.amount else 0 end), 0)::numeric(12,2) as paid_out
  from merchant_settlements s
  group by s.merchant_id
)
select
  m.id as merchant_id,
  m.name as merchant_name,
  coalesce(e.held_amount, 0)::numeric(12,2) as held_amount,
  coalesce(s.available_amount, 0)::numeric(12,2) as available_amount,
  coalesce(s.payout_processing, 0)::numeric(12,2) as payout_processing,
  coalesce(s.paid_out, 0)::numeric(12,2) as paid_out,
  coalesce(e.total_sales, 0)::numeric(12,2) as total_sales,
  coalesce(e.pending_amount, 0)::numeric(12,2) as pending_amount,
  coalesce(e.disputed_amount, 0)::numeric(12,2) as disputed_amount
from merchants m
left join escrow_totals e on e.merchant_id = m.id
left join settlement_totals s on s.merchant_id = m.id;

create index if not exists escrow_disputes_created_idx
  on escrow_disputes(created_at desc);
