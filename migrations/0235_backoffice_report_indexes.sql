-- Back-office reports (/admin/reports): indexes for the date-range scans.
-- EXPLAIN on a 300k-order database showed sequential scans of
-- payment_state_transitions (paid orders are dated by their completion
-- transition) and of orders (checkouts placed in a range). Read-only feature:
-- no data or function changes.

create index if not exists payment_state_transitions_completed_at_idx
  on payment_state_transitions (created_at, payment_id)
  where to_status = 'completed';

create index if not exists orders_created_at_idx
  on orders (created_at);
