-- Public catalog cleanup: additive, reversible snapshots; never rewrite old migrations.
-- Only unclaimed legacy sample shops with no order history qualify.
create table if not exists legacy_preview_quarantine (
  entity_type text not null,
  entity_id text not null,
  original_row jsonb not null,
  quarantined_at timestamptz not null default now(),
  reason text not null,
  primary key (entity_type, entity_id)
);
create temporary table release_seed_candidates on commit drop as
select m.id from merchants m join (values
    ('mer_labone_kitchen','Labone Kitchen'),
    ('mer_makola','Makola Fresh'),
    ('mer_osu_atelier','Osu Atelier'),
    ('mer_eastlegon_tech','East Legon Tech'),
    ('mer_circle_beauty','Circle Shea Co.'),
    ('mer_madina_agri','Madina Agritrade'),
    ('mer_tema_home','Tema Houseworks'),
    ('mer_cantonments_stay','Cantonments Stay')
) seed(id,name) on m.id=seed.id and m.name=seed.name
where m.status='active' and m.verified=true
  and not exists(select 1 from merchant_accounts a where a.merchant_id=m.id)
  and not exists(select 1 from orders o where o.merchant_id=m.id)
  and not exists(select 1 from products p where p.merchant_id=m.id and p.id not in ('p_jollof','p_waakye','p_kelewele','p_banku','p_tomatoes','p_rice','p_shea','p_kente','p_dress','p_bag','p_sneakers','p_phone','p_earbuds','p_laptop','p_cocoa','p_sofa','p_stay_garden','p_stay_osu'));
insert into legacy_preview_quarantine(entity_type,entity_id,original_row,reason)
select 'merchant',m.id,to_jsonb(m),'Unclaimed historical sample catalog'
from merchants m join release_seed_candidates c on c.id=m.id on conflict do nothing;
insert into legacy_preview_quarantine(entity_type,entity_id,original_row,reason)
select 'product',p.id,to_jsonb(p),'Unclaimed historical sample catalog'
from products p join release_seed_candidates c on c.id=p.merchant_id on conflict do nothing;
update products set status='archived' where merchant_id in(select id from release_seed_candidates);
update merchants set status='pending',verified=false where id in(select id from release_seed_candidates);
insert into legacy_preview_quarantine(entity_type,entity_id,original_row,reason)
select 'payment_provider',p.id,to_jsonb(p),'Legacy automatic preview provider'
from payment_providers p where p.provider_key in('preview','preview-card','preview-bank')
  and p.id in('pp-preview-momo','pp-preview-card','pp-preview-bank') and p.status='active'
on conflict do nothing;
update payment_providers set status='inactive',updated_at=now()
where provider_key in('preview','preview-card','preview-bank')
  and id in('pp-preview-momo','pp-preview-card','pp-preview-bank') and status='active';
