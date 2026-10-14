-- v1.35.0 IDOR/BOLA hardening.
-- Object IDs are never authorization. Sensitive reads/actions must bind the
-- requested object to the authenticated customer or verified merchant scope.

create index if not exists payments_user_idx on payments(user_id, created_at desc);
create index if not exists customer_financing_application_owner_idx
  on customer_financing_applications(user_id, created_at desc);
create index if not exists merchant_financing_application_owner_idx
  on merchant_financing_applications(merchant_id, created_at desc);

-- Keep the relationship between an order and its group immutable through normal
-- application paths. The application layer remains responsible for principal
-- authorization; these constraints make ownership joins deterministic.
create index if not exists order_groups_user_idx on order_groups(user_id, created_at desc);

-- Payment ownership must agree with the owning order. This trigger prevents a
-- future write path from attaching a payment to a different user's order.
create or replace function validate_payment_order_owner()
returns trigger language plpgsql as $$
declare
  v_user text;
begin
  select user_id into v_user from orders where id = new.order_id;
  if v_user is null then raise exception 'order not found'; end if;
  if new.user_id <> v_user then raise exception 'payment order ownership mismatch'; end if;
  return new;
end;
$$;
drop trigger if exists payments_order_owner_validate on payments;
create trigger payments_order_owner_validate
before insert or update of order_id, user_id on payments
for each row execute function validate_payment_order_owner();
