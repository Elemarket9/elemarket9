import { readFile, readdir } from 'node:fs/promises';
import { pendingMigrations } from '../migration-plan.mjs';
export async function migrateDiscoveryFixture(db) {for(const {name} of pendingMigrations(await readdir('migrations'),[]))await db.transaction(async tx=>tx.exec(await readFile(`migrations/${name}`,'utf8')));}
export async function seedDiscoveryFixture(db) {
  await db.exec("update products set status='archived'");
  await db.exec("insert into merchants(id,name,category,status,verified,address,city,neighborhood,lat,lon,catalog_categories) values ('v11_old','Incumbent Merchant','electronics','active',true,'Test address','Accra','Test',5.60,-.18,array['electronics']),('v11_new','New Merchant','electronics','active',true,'Test address','Accra','Test',5.61,-.18,array['electronics']),('v11_shoe','Shoe Merchant','fashion','active',true,'Test address','Accra','Test',5.60,-.18,array['fashion'])");
  const rows=[
    ['v11_phone','v11_old','Samsung Phone','electronics','mobile-phones',2000,'Samsung','S24','A55_SKU/RED',{network:'5G',storage_gb:256,ram_gb:8},'2025-01-01'],
    ['v11_smartphone','v11_new','Samsung Smartphone','electronics','mobile-phones',1900,'Samsung','A55','B55_SKU/BLUE',{network:'5G',storage_gb:512,ram_gb:16},'2026-01-01'],
    ['v11_phone_unknown','v11_new','Basic Phone','electronics',null,500,null,null,null,{},'2026-02-01'],
    ['v11_laptop','v11_old','Laptop Pro','electronics','laptops',5000,'Maker','L16',null,{cpu:'CPU',os:'Linux',screen_inches:15,ram_gb:16,storage_gb:512,storage_type:'SSD'},'2025-01-01'],
    ['v11_notebook','v11_new','Notebook Standard','electronics','laptops',2500,'Maker','L8',null,{cpu:'CPU',os:'Linux',screen_inches:15,ram_gb:8,storage_gb:256,storage_type:'HDD'},'2026-01-01'],
    ['v11_tv','v11_old','55 inch TV','electronics','tv',3500,'Samsung','TV55',null,{screen_inches:55,resolution:'4K',smart_tv:true},'2025-01-01'],
    ['v11_television','v11_new','Television','electronics','tv',2000,'Maker','TV43',null,{screen_inches:43,resolution:'1080p',smart_tv:true},'2026-01-01'],
    ['v11_shoes','v11_shoe','Black Shoes','fashion','footwear',250,null,null,null,{color:'black',size:'42'},'2025-01-01'],
    ['v11_shoes_other','v11_shoe','White Shoes','fashion','footwear',200,null,null,null,{color:'white',size:'41'},'2026-01-01'],
    ['v11_irrelevant','v11_old','Cheap Cable','electronics','phone-accessories',1,null,null,null,{},'2026-03-01'],
  ];
  for(const [id,merchant,name,category,subcategory,price,brand,model,sku,attributes,created] of rows)await db.query(`insert into products(id,merchant_id,name,category,subcategory,price,stock,brand,model,sku,attributes,created_at)values($1,$2,$3,$4,$5,$6,10,$7,$8,$9,$10::jsonb,$11::timestamptz)`,[id,merchant,name,category,subcategory,price,brand,model,sku,JSON.stringify(attributes),created]);
  await db.exec("select refresh_eide_features(50)");
}
export const syntheticJudgments=[
 {name:'identifier',q:'A55_SKU/RED',judgments:{v11_phone:4}},
 {name:'original-before-synonym',q:'TV',judgments:{v11_tv:4,v11_television:2}},
 {name:'laptop-synonym',q:'laptop',judgments:{v11_laptop:4,v11_notebook:2}},
 {name:'storage',q:'Samsung 256GB phone',judgments:{v11_phone:4,v11_smartphone:1}},
 {name:'memory',q:'16GB RAM laptop',judgments:{v11_laptop:4,v11_notebook:1}},
 {name:'display',q:'55 inch 4K TV',judgments:{v11_tv:4,v11_television:1}},
 {name:'footwear',q:'black size 42 shoes',judgments:{v11_shoes:4,v11_shoes_other:1}},
 {name:'hard-budget',q:'phones under GHS 2000',judgments:{v11_phone:3,v11_smartphone:3,v11_phone_unknown:2}},
];
