-- Fix the variant price-history trigger: product_variants does not own currency.
-- Currency is authoritative on the parent products row.
create or replace function record_variant_price_history()
returns trigger language plpgsql as $$
begin
  if tg_op='INSERT' or new.price is distinct from old.price then
    insert into variant_price_history(variant_id,product_id,price,currency,effective_at)
    select new.id,new.product_id,new.price,p.currency,now()
      from products p
     where p.id=new.product_id;
    if not found then raise exception 'variant price history product not found'; end if;
  end if;
  return new;
end;
$$;
