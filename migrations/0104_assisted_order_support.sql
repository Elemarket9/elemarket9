-- v1.74: Agent-assisted ordering through ELEMARKET Support.
-- Agents may prepare a draft for the authenticated customer. They never collect
-- or control payment credentials and cannot silently create a payable order.

create table if not exists support_order_drafts (
  id text primary key,
  conversation_id text not null references support_conversations(id) on delete cascade,
  customer_id text not null references "user"(id) on delete restrict,
  created_by text not null references "user"(id) on delete restrict,
  items jsonb not null check (jsonb_typeof(items)='array' and jsonb_array_length(items) between 1 and 40),
  status text not null default 'pending' check (status in ('pending','checkout_started','completed','expired','cancelled')),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_order_drafts_customer_status_idx
  on support_order_drafts(customer_id, status, updated_at desc);
create index if not exists support_order_drafts_conversation_status_idx
  on support_order_drafts(conversation_id, status, updated_at desc);
create unique index if not exists support_order_drafts_one_pending_per_conversation_uq
  on support_order_drafts(conversation_id)
  where status in ('pending','checkout_started');

alter table order_groups add column if not exists assisted_draft_id text references support_order_drafts(id) on delete restrict;
create index if not exists order_groups_assisted_draft_idx on order_groups(assisted_draft_id) where assisted_draft_id is not null;

create or replace function create_assisted_order_draft(
  p_support_id text,
  p_conversation_id text,
  p_items jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_conversation record;
  v_item record;
  v_product record;
  v_customer text;
  v_merchant text;
  v_first_merchant text;
  v_id text;
  v_items jsonb := '[]'::jsonb;
begin
  if current_setting('app.user_id', true) is distinct from p_support_id then raise exception 'unauthorized'; end if;
  if p_support_id is null or length(trim(p_support_id)) < 1 then raise exception 'support identity required'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>40 then raise exception 'invalid assisted order items'; end if;

  select * into v_conversation from support_conversations where id=p_conversation_id for update;
  if not found then raise exception 'conversation not found'; end if;
  if v_conversation.status='closed' then raise exception 'conversation is closed'; end if;
  v_customer := v_conversation.customer_id;

  perform pg_advisory_xact_lock(hashtextextended('elemarket:assisted-order:'||p_conversation_id,0));
  if exists(select 1 from support_order_drafts where conversation_id=p_conversation_id and status in ('pending','checkout_started')) then
    raise exception 'an assisted order is already active for this conversation';
  end if;

  for v_item in
    select trim(elem->>'productId') as product_id,
           nullif(trim(elem->>'variantId'),'') as variant_id,
           (elem->>'quantity')::int as quantity
      from jsonb_array_elements(p_items) elem
  loop
    if v_item.product_id is null or v_item.product_id='' or v_item.quantity is null or v_item.quantity<1 or v_item.quantity>20 then raise exception 'invalid assisted order item'; end if;
    select p.id,p.merchant_id,p.name,p.price,p.stock,p.currency,p.status,m.status as merchant_status,m.verified
      into v_product
      from products p join merchants m on m.id=p.merchant_id
     where p.id=v_item.product_id for update of p;
    if not found or v_product.status<>'active' or v_product.merchant_status<>'active' or v_product.verified is not true then raise exception 'product is not currently orderable'; end if;
    v_merchant := v_product.merchant_id;
    if v_first_merchant is null then v_first_merchant:=v_merchant; elsif v_first_merchant<>v_merchant then raise exception 'assisted order must contain one merchant'; end if;
    if v_item.variant_id is not null then
      perform 1 from product_variants pv where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active' and pv.stock>=v_item.quantity for update;
      if not found then raise exception 'variant is not currently available'; end if;
    elsif v_product.stock<v_item.quantity then raise exception 'product is not currently available'; end if;
    if v_product.currency<>'GHS' then raise exception 'unsupported currency'; end if;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('productId',v_item.product_id,'variantId',v_item.variant_id,'quantity',v_item.quantity));
  end loop;

  v_id:='aod_'||replace(gen_random_uuid()::text,'-','');
  insert into support_order_drafts(id,conversation_id,customer_id,created_by,items)
  values(v_id,p_conversation_id,v_customer,p_support_id,v_items);
  insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key,request_hash)
  values('msg_'||replace(gen_random_uuid()::text,'-',''),p_conversation_id,p_support_id,'support',
         'I have prepared an order for you. Please review the order details in this chat and approve it before payment.',
         'draft_'||v_id,encode(digest('I have prepared an order for you. Please review the order details in this chat and approve it before payment.','sha256'),'hex'));
  update support_conversations set updated_at=now(),status='waiting_customer' where id=p_conversation_id;
  return jsonb_build_object('draftId',v_id,'conversationId',p_conversation_id,'expiresAt',(select expires_at from support_order_drafts where id=v_id),'items',v_items);
end;
$$;

create or replace function get_assisted_order_draft(
  p_customer_id text,
  p_draft_id text
) returns jsonb
language plpgsql
as $$
declare v_draft record; v_items jsonb := '[]'::jsonb; v_item record; v_product record; v_variant record;
begin
  select d.* into v_draft from support_order_drafts d where d.id=p_draft_id and d.customer_id=p_customer_id for update;
  if not found then raise exception 'assisted order draft not found'; end if;
  if v_draft.expires_at<=now() and v_draft.status in ('pending','checkout_started') then
    update support_order_drafts set status='expired',updated_at=now() where id=v_draft.id;
    raise exception 'assisted order draft expired';
  end if;
  if v_draft.status not in ('pending','checkout_started') then raise exception 'assisted order draft unavailable'; end if;
  for v_item in select value as item from jsonb_array_elements(v_draft.items)
  loop
    select p.id,p.merchant_id,p.name,p.price,p.stock,p.currency,p.status,m.name as merchant_name,m.status as merchant_status,m.verified
      into v_product from products p join merchants m on m.id=p.merchant_id where p.id=v_item.item->>'productId';
    if not found or v_product.status<>'active' or v_product.merchant_status<>'active' or v_product.verified is not true then raise exception 'assisted order contains unavailable product'; end if;
    if nullif(trim(v_item.item->>'variantId'),'') is not null then
      select id,name,price,stock,status into v_variant from product_variants where id=trim(v_item.item->>'variantId') and product_id=v_product.id and status='active';
      if not found then raise exception 'assisted order contains unavailable variant'; end if;
      v_items:=v_items||jsonb_build_array(jsonb_build_object('productId',v_product.id,'variantId',v_variant.id,'quantity',(v_item.item->>'quantity')::int,'name',coalesce(v_variant.name,v_product.name),'price',v_variant.price::text,'merchantId',v_product.merchant_id,'merchantName',v_product.merchant_name,'stock',v_variant.stock));
    else
      v_items:=v_items||jsonb_build_array(jsonb_build_object('productId',v_product.id,'variantId',null,'quantity',(v_item.item->>'quantity')::int,'name',v_product.name,'price',v_product.price::text,'merchantId',v_product.merchant_id,'merchantName',v_product.merchant_name,'stock',v_product.stock));
    end if;
  end loop;
  return jsonb_build_object('draftId',v_draft.id,'conversationId',v_draft.conversation_id,'status',v_draft.status,'expiresAt',v_draft.expires_at,'items',v_items);
end;
$$;

create or replace function consume_assisted_draft_for_checkout()
returns trigger language plpgsql
as $$
declare v_draft record; v_draft_id text;
begin
  v_draft_id:=nullif(current_setting('app.assisted_draft_id',true),'');
  if v_draft_id is null then return new; end if;
  select * into v_draft from support_order_drafts where id=v_draft_id for update;
  if not found then raise exception 'assisted order draft not found'; end if;
  if v_draft.customer_id<>new.user_id then raise exception 'assisted order customer mismatch'; end if;
  if v_draft.status<>'pending' or v_draft.expires_at<=now() then raise exception 'assisted order draft unavailable'; end if;
  if v_draft.created_by is null then raise exception 'assisted order draft invalid'; end if;
  new.assisted_draft_id:=v_draft.id;
  update support_order_drafts set status='checkout_started',updated_at=now() where id=v_draft.id;
  return new;
end;
$$;

drop trigger if exists order_group_assisted_draft on order_groups;
create trigger order_group_assisted_draft
before insert on order_groups
for each row execute function consume_assisted_draft_for_checkout();

create or replace function complete_assisted_draft_after_order()
returns trigger language plpgsql
as $$
declare v_draft text;
begin
  select assisted_draft_id into v_draft from order_groups where id=new.group_id;
  if v_draft is not null then
    update support_order_drafts set status='completed',updated_at=now() where id=v_draft and status='checkout_started';
  end if;
  return new;
end;
$$;

drop trigger if exists order_assisted_draft_completed on orders;
create trigger order_assisted_draft_completed
after insert on orders
for each row execute function complete_assisted_draft_after_order();

comment on table support_order_drafts is 'Agent-prepared customer order drafts. Customer must review and complete provider checkout; support agents cannot collect payment credentials.';

create or replace function validate_assisted_order_matches_draft()
returns trigger language plpgsql
as $$
declare v_draft_id text; v_expected jsonb; v_actual jsonb;
begin
  select assisted_draft_id into v_draft_id from order_groups where id=new.group_id;
  if v_draft_id is null then return new; end if;
  select items into v_expected from support_order_drafts where id=v_draft_id for update;
  if v_expected is null then raise exception 'assisted order draft missing'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('productId',oi.product_id,'variantId',oi.variant_id,'quantity',oi.quantity) order by oi.product_id,coalesce(oi.variant_id,'')), '[]'::jsonb)
    into v_actual
    from order_items oi where oi.order_id=new.id;
  select coalesce(jsonb_agg(jsonb_build_object('productId',x.product_id,'variantId',x.variant_id,'quantity',x.quantity) order by x.product_id,coalesce(x.variant_id,'')), '[]'::jsonb)
    into v_expected
    from jsonb_to_recordset(v_expected) as x(product_id text,variant_id text,quantity integer);
  if v_actual<>v_expected then raise exception 'assisted order was modified after customer review'; end if;
  return new;
end;
$$;

drop trigger if exists order_assisted_draft_integrity on orders;
create trigger order_assisted_draft_integrity
after insert on orders
for each row execute function validate_assisted_order_matches_draft();

-- Do not allow a normal customer to invoke the agent-draft creation function even
-- if the database function is called directly instead of through the admin API.
create or replace function create_assisted_order_draft(
  p_support_id text,
  p_conversation_id text,
  p_items jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_conversation record; v_item record; v_product record; v_customer text; v_merchant text;
  v_first_merchant text; v_id text; v_items jsonb := '[]'::jsonb; v_role text;
begin
  if current_setting('app.user_id', true) is distinct from p_support_id then raise exception 'unauthorized'; end if;
  select role into v_role from "user" where id=p_support_id;
  if v_role<>'admin' then raise exception 'support agent role required'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>40 then raise exception 'invalid assisted order items'; end if;
  select * into v_conversation from support_conversations where id=p_conversation_id for update;
  if not found or v_conversation.status='closed' then raise exception 'conversation unavailable'; end if;
  v_customer:=v_conversation.customer_id;
  perform pg_advisory_xact_lock(hashtextextended('elemarket:assisted-order:'||p_conversation_id,0));
  if exists(select 1 from support_order_drafts where conversation_id=p_conversation_id and status in ('pending','checkout_started')) then raise exception 'an assisted order is already active for this conversation'; end if;
  for v_item in select trim(elem->>'productId') as product_id,nullif(trim(elem->>'variantId'),'') as variant_id,(elem->>'quantity')::int as quantity from jsonb_array_elements(p_items) elem loop
    if v_item.product_id is null or v_item.product_id='' or v_item.quantity is null or v_item.quantity<1 or v_item.quantity>20 then raise exception 'invalid assisted order item'; end if;
    select p.id,p.merchant_id,p.name,p.price,p.stock,p.currency,p.status,m.status as merchant_status,m.verified into v_product from products p join merchants m on m.id=p.merchant_id where p.id=v_item.product_id for update of p;
    if not found or v_product.status<>'active' or v_product.merchant_status<>'active' or v_product.verified is not true then raise exception 'product is not currently orderable'; end if;
    v_merchant:=v_product.merchant_id;
    if v_first_merchant is null then v_first_merchant:=v_merchant; elsif v_first_merchant<>v_merchant then raise exception 'assisted order must contain one merchant'; end if;
    if v_item.variant_id is not null then perform 1 from product_variants pv where pv.id=v_item.variant_id and pv.product_id=v_item.product_id and pv.status='active' and pv.stock>=v_item.quantity for update; if not found then raise exception 'variant is not currently available'; end if; elsif v_product.stock<v_item.quantity then raise exception 'product is not currently available'; end if;
    if v_product.currency<>'GHS' then raise exception 'unsupported currency'; end if;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('productId',v_item.product_id,'variantId',v_item.variant_id,'quantity',v_item.quantity));
  end loop;
  v_id:='aod_'||replace(gen_random_uuid()::text,'-','');
  insert into support_order_drafts(id,conversation_id,customer_id,created_by,items) values(v_id,p_conversation_id,v_customer,p_support_id,v_items);
  insert into support_messages(id,conversation_id,sender_id,sender_type,body,idempotency_key,request_hash) values('msg_'||replace(gen_random_uuid()::text,'-',''),p_conversation_id,p_support_id,'support','I have prepared an order for you. Please review the order details in this chat and approve it before payment.','draft_'||v_id,encode(digest('I have prepared an order for you. Please review the order details in this chat and approve it before payment.','sha256'),'hex'));
  update support_conversations set updated_at=now(),status='waiting_customer' where id=p_conversation_id;
  return jsonb_build_object('draftId',v_id,'conversationId',p_conversation_id,'expiresAt',(select expires_at from support_order_drafts where id=v_id),'items',v_items);
end;
$$;
