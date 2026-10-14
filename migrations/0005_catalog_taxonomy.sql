-- ELEMARKET catalogue taxonomy and product merchandising fields.
-- Stable keys are used for filtering; display labels remain application-owned.

alter table products add column if not exists subcategory text;
alter table products add column if not exists brand text;
alter table products add column if not exists model text;
alter table products add column if not exists sku text;
alter table products add column if not exists condition text not null default 'new';
alter table products add column if not exists attributes jsonb not null default '{}'::jsonb;
alter table products add column if not exists warranty_months integer;
alter table products add column if not exists fulfillment_type text not null default 'delivery';

alter table products add constraint products_condition_check
  check (condition in ('new','refurbished','used','open_box')) not valid;
alter table products add constraint products_fulfillment_type_check
  check (fulfillment_type in ('delivery','pickup','delivery_and_pickup')) not valid;
alter table products add constraint products_warranty_check
  check (warranty_months is null or warranty_months between 0 and 120) not valid;
alter table products add constraint products_attributes_object_check
  check (jsonb_typeof(attributes) = 'object') not valid;

create unique index if not exists products_merchant_sku_uq
  on products(merchant_id, sku) where sku is not null and sku <> '';
create index if not exists products_subcategory_idx on products(category, subcategory);
create index if not exists products_brand_idx on products(brand) where brand is not null;

-- Canonical category/subcategory metadata for merchant catalogue services.
create table if not exists category_taxonomy (
  category_key text primary key,
  name text not null,
  active boolean not null default true,
  sort_order integer not null check (sort_order >= 0)
);
create table if not exists category_subcategories (
  category_key text not null references category_taxonomy(category_key),
  subcategory_key text not null,
  name text not null,
  active boolean not null default true,
  sort_order integer not null check (sort_order >= 0),
  primary key(category_key, subcategory_key)
);
create index if not exists category_subcategories_active_idx
  on category_subcategories(category_key, active, sort_order);


insert into category_taxonomy(category_key,name,sort_order) values
  ('food','Food & Dining',10),('restaurants','Restaurants',20),('groceries','Groceries',30),('electronics','Electronics',40),
  ('fashion','Fashion',50),('beauty','Beauty & Personal Care',60),('home','Home & Living',70),('agriculture','Agriculture',80),
  ('automotive','Automotive',90),('health','Health & Wellness',100),('hospitality','Stays & Hospitality',110),('baby-kids','Baby & Kids',120),('books-media','Books & Media',130),('sports','Sports & Outdoors',140),('office','Office & School',150),('industrial-machinery','Industrial Machinery',160),('construction','Construction & Tools',170),('pets','Pets & Supplies',180),('services','Services',190)
on conflict (category_key) do update set name=excluded.name, sort_order=excluded.sort_order;

insert into category_subcategories(category_key,subcategory_key,name,sort_order) values
('electronics','mobile-phones','Mobile Phones',10),('electronics','phone-accessories','Phone Accessories',20),('electronics','laptops','Laptops',30),('electronics','desktops','Desktops',40),('electronics','tablets','Tablets',50),('electronics','computer-accessories','Computer Accessories',60),('electronics','monitors','Monitors',70),('electronics','printers','Printers & Scanners',80),('electronics','networking','Networking',90),('electronics','storage','Storage',100),('electronics','components','Computer Components',110),('electronics','audio','Audio',120),('electronics','cameras','Cameras & Photography',130),('electronics','gaming','Gaming',140),('electronics','smart-home','Smart Home',150),('electronics','power','Power & Charging',160),('electronics','wearables','Wearables',170),('electronics','tv','TV & Video',180),
('fashion','womens-clothing','Women''s Clothing',10),('fashion','mens-clothing','Men''s Clothing',20),('fashion','kids-clothing','Kids'' Clothing',30),('fashion','footwear','Footwear',40),('fashion','bags','Bags',50),('fashion','jewelry','Jewelry & Watches',60),('fashion','fashion-accessories','Fashion Accessories',70),
('home','furniture','Furniture',10),('home','home-decor','Home Decor',20),('home','kitchen','Kitchen & Dining',30),('home','appliances','Home Appliances',40),('home','refrigerators','Refrigerators',50),('home','freezers','Freezers',60),('home','washing-machines','Washing Machines',70),('home','dryers','Dryers',80),('home','dishwashers','Dishwashers',90),('home','cookers-ovens','Cookers & Ovens',100),('home','microwaves','Microwaves',110),('home','blenders-mixers','Blenders & Mixers',120),('home','air-conditioners','Air Conditioners',130),('home','fans','Fans',140),('home','water-heaters','Water Heaters',150),('home','vacuum-cleaners','Vacuum Cleaners',160),('home','irons','Irons',170),('home','small-appliances','Small Appliances',180),('home','bedding','Bedding & Bath',190),('home','lighting','Lighting',200),
('automotive','cars','Cars',10),('automotive','motorcycles','Motorcycles',20),('automotive','parts','Parts',30),('automotive','tires','Tires & Wheels',40),('automotive','car-care','Car Care',50),('automotive','accessories','Accessories',60),
('agriculture','farm-produce','Farm Produce',10),('agriculture','seeds','Seeds',20),('agriculture','fertilizer','Fertilizer & Inputs',30),('agriculture','farm-equipment','Farm Equipment',40),('agriculture','livestock','Livestock',50),
('health','otc','OTC Products',10),('health','medical-devices','Medical Devices',20),('health','wellness','Wellness',30),('health','pharmacy-services','Pharmacy Services',40),
('services','repairs','Repairs',10),('services','cleaning','Cleaning',20),('services','beauty-services','Beauty Services',30),('services','professional','Professional Services',40),('services','lessons','Lessons & Training',50),('services','events','Events',60)
on conflict (category_key,subcategory_key) do update set name=excluded.name, sort_order=excluded.sort_order;

-- Remaining taxonomy groups are seeded here so merchant/admin tooling has one canonical source.
insert into category_subcategories(category_key,subcategory_key,name,sort_order) values
('food','prepared-meals','Prepared Meals',10),('food','fast-food','Fast Food',20),('food','bakery','Bakery & Pastry',30),('food','drinks','Drinks & Beverages',40),('food','catering','Catering',50),
('restaurants','ghanaian','Ghanaian',10),('restaurants','continental','Continental',20),('restaurants','african','African',30),('restaurants','fast-casual','Fast Casual',40),
('groceries','fresh-produce','Fresh Produce',10),('groceries','staples','Staples',20),('groceries','meat-seafood','Meat & Seafood',30),('groceries','beverages','Beverages',40),('groceries','household-consumables','Household Consumables',50),
('beauty','skincare','Skincare',10),('beauty','haircare','Haircare',20),('beauty','makeup','Makeup',30),('beauty','fragrance','Fragrance',40),('beauty','personal-care','Personal Care',50),
('hospitality','apartments','Apartments',10),('hospitality','hotels','Hotels',20),('hospitality','guesthouses','Guesthouses',30),('hospitality','short-stays','Short Stays',40)
on conflict (category_key,subcategory_key) do update set name=excluded.name, sort_order=excluded.sort_order;

create or replace function validate_product_taxonomy() returns trigger language plpgsql as $$
begin
  if new.subcategory is not null and not exists (
    select 1 from category_subcategories s
     where s.category_key = new.category and s.subcategory_key = new.subcategory and s.active
  ) then
    raise exception 'invalid product subcategory for category';
  end if;
  return new;
end;
$$;
drop trigger if exists products_taxonomy_validate on products;
create trigger products_taxonomy_validate before insert or update of category, subcategory on products
for each row execute function validate_product_taxonomy();

insert into category_subcategories(category_key,subcategory_key,name,sort_order) values
('baby-kids','baby-care','Baby Care',10),('baby-kids','baby-gear','Baby Gear',20),('baby-kids','kids-toys','Kids Toys',30),('baby-kids','school-items','School Items',40),
('books-media','books','Books',10),('books-media','school-books','School Books',20),('books-media','music-media','Music & Media',30),
('sports','fitness','Fitness',10),('sports','football','Football',20),('sports','sports-equipment','Sports Equipment',30),('sports','outdoor','Outdoor',40),
('office','stationery','Stationery',10),('office','office-equipment','Office Equipment',20),('office','school-supplies','School Supplies',30),
('industrial-machinery','sewing-machines','Sewing Machines',10),('industrial-machinery','garment-equipment','Garment Equipment',20),('industrial-machinery','workshop-tools','Workshop Tools',30),('industrial-machinery','industrial-equipment','Industrial Equipment',40),
('construction','building-materials','Building Materials',10),('construction','hand-tools','Hand Tools',20),('construction','power-tools','Power Tools',30),('construction','safety-equipment','Safety Equipment',40),
('pets','pet-food','Pet Food',10),('pets','pet-care','Pet Care',20),('pets','pet-accessories','Pet Accessories',30)
on conflict (category_key,subcategory_key) do update set name=excluded.name, sort_order=excluded.sort_order;

update products set subcategory='mobile-phones', brand='Samsung', model='A25 5G', condition='new', warranty_months=12, fulfillment_type='delivery', attributes='{"network":"5G","storage_gb":128,"ram_gb":8,"unlocked":true}'::jsonb where id='p_phone';
update products set subcategory='phone-accessories', condition='new', fulfillment_type='delivery', attributes='{"type":"wireless-earbuds","charging_case":true}'::jsonb where id='p_earbuds';
update products set subcategory='laptops', brand='Generic', model='14-inch Notebook', condition='new', warranty_months=12, fulfillment_type='delivery_and_pickup', attributes='{"screen_inches":14,"cpu":"Intel i5","ram_gb":8,"storage_gb":256,"os":"Windows 11"}'::jsonb where id='p_laptop';
