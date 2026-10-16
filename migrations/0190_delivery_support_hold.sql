-- Customer-support delivery hold: restrict physical movement while verifying a
-- delivery problem, with an audited support-only path to release a hold.
create table if not exists order_delivery_holds (
 order_id text primary key references orders(id),
 active boolean not null default true,
 reason text not null check(char_length(reason) between 12 and 1000),
 placed_by text not null,
 placed_at timestamptz not null default now(),
 released_by text,
 released_at timestamptz,
 release_reason text,
 updated_at timestamptz not null default now()
);
create index if not exists order_delivery_holds_active_idx on order_delivery_holds(order_id) where active;

create or replace function elemarket_enforce_delivery_hold() returns trigger language plpgsql as $$
begin
 -- Serialize partner progress with the order lock held by support hold actions.
 perform 1 from orders where id=new.order_id for key share;
 if new.status in ('accepted','picked_up','in_transit','delivered')
   and old.status is distinct from new.status
   and exists (select 1 from order_delivery_holds h where h.order_id=new.order_id and h.active)
 then raise exception 'delivery paused by ELEMARKET support'; end if;
 return new;
end $$;
create trigger elemarket_delivery_hold_transition_guard before update of status on delivery_jobs
 for each row execute function elemarket_enforce_delivery_hold();
