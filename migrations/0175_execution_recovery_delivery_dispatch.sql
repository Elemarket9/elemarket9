-- Additive recovery controls; historical migration checksums remain immutable.
alter table payments add column if not exists reconciliation_attempted_at timestamptz;
alter table provider_refund_requests add column if not exists execution_token text;
alter table provider_refund_requests add column if not exists execution_lease_until timestamptz;
alter table provider_refund_requests add column if not exists creation_attempted_at timestamptz;
alter table provider_refund_requests add column if not exists provider_state_version integer not null default 0;
-- Legacy executions may have reached the provider before this column existed.
update provider_refund_requests set creation_attempted_at=updated_at
where status<>'requested' or provider_refund_id is not null or provider_response is not null;

-- A late response or lifecycle event cannot undo terminal provider confirmation.
create or replace function guard_refund_progress() returns trigger language plpgsql as $$
begin
  if old.status='processed' and new.status<>'processed' then return null; end if;
  if old.status='failed' and new.status in ('processing','needs_attention') then return null; end if;
  if old.status in ('processing','needs_attention') and new.status='requested' then return null; end if;
  if new.status is distinct from old.status or new.provider_refund_id is distinct from old.provider_refund_id then
    new.provider_state_version=old.provider_state_version+1;
  end if;
  if new.status in ('processed','failed') then
    new.execution_token=null; new.execution_lease_until=null;
  end if;
  return new;
end $$;
create trigger refund_progress_guard before update on provider_refund_requests
for each row execute function guard_refund_progress();

create table delivery_dispatch_outbox (
  order_id text primary key references orders(id),
  status text not null default 'pending' check(status in ('pending','processing','dispatched','manual','needs_attention','cancelled')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token text, lease_until timestamptz, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create or replace function queue_order_delivery() returns trigger language plpgsql as $$
begin
  if new.status in ('paid','confirmed','fulfilling') and new.delivery_quote_id is not null then
    insert into delivery_dispatch_outbox(order_id) values(new.id) on conflict do nothing;
  elsif new.status in ('cancelled','refunded','refund_pending','expired') then
    update delivery_dispatch_outbox set status='cancelled',lease_token=null,lease_until=null,updated_at=now()
     where order_id=new.id and status in ('pending','processing','needs_attention');
  end if;
  return new;
end $$;
create trigger order_delivery_outbox after insert or update of status on orders
for each row execute function queue_order_delivery();
insert into delivery_dispatch_outbox(order_id)
select id from orders where status in ('paid','confirmed','fulfilling') and delivery_quote_id is not null
on conflict do nothing;
