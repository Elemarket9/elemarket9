-- v1.59: provider-refund-only runtime boundary.
-- Historical escrow tables/functions remain in migration history for upgrade
-- compatibility, but no live application path may read, write, release, or
-- settle funds through them. Provider refund requests are the sole runtime
-- refund/dispute money-flow record.

create index if not exists provider_refund_requests_status_idx
  on provider_refund_requests(status, requested_at desc)
  where status in ('requested','processing','needs_attention','failed');

comment on table provider_refund_requests is
  'LIVE provider-managed refund operations. ELEMARKET never holds, releases, settles, or custodians customer funds.';

comment on column provider_refund_requests.status is
  'Provider workflow state. A processed/failed state reflects provider execution; it is not an ELEMARKET settlement state.';
