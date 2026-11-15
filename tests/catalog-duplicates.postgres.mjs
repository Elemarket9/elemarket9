// Real PostgreSQL catalogue duplicate regressions. No production data is modified.
// RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL=postgres://.../market_test
// node --test tests/catalog-duplicates.postgres.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "Requires disposable PostgreSQL integration database ending in _test";
let database, pool;
before(async () => {
  if (!enabled) return;
  database = await createMigratedTestDatabase();
  pool = new pg.Pool({ connectionString: database.url, max: 5 });
});
after(async () => {
  await pool?.end();
  await database?.drop();
});

const id = (prefix) => prefix + "_" + randomUUID().replaceAll("-", "");
async function merchant() {
  const merchantId = id("dup_mer");
  await pool.query(`insert into merchants(id,name,category,status,verified,tier,address,city,neighborhood,lat,lon,catalog_categories)
    values($1,'Catalog Test Merchant','electronics','active',true,'merchant','1 Test Street','Accra','Osu',5.6,-0.18,array['electronics'])`, [merchantId]);
  return merchantId;
}
async function listing(merchantId, name, sku = null, { brand = null, model = null, category = "electronics", status = "pending_review" } = {}) {
  const productId = id("dup_product");
  await pool.query(`insert into products(id,merchant_id,name,category,price,currency,stock,description,status,sku,brand,model)
    values($1,$2,$3,$4,100,'GHS',5,'catalog duplicate regression',$5,$6,$7,$8)`,
    [productId,merchantId,name,category,status,sku,brand,model]);
  return productId;
}
async function rejectedDuplicate(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, "23505");
    assert.match(error.message, /Duplicate merchant catalog listing/);
    return true;
  });
}

test("merchant SKU identity is case- and whitespace-insensitive", { skip }, async () => {
  const merchantId = await merchant();
  await listing(merchantId, "Product Alpha", " AbC-123 ");
  await rejectedDuplicate(listing(merchantId, "Different Product", "abc-123"));
  await listing(await merchant(), "Other Merchant Offer", "ABC-123");
});

test("exact no-SKU identities are rejected but distinct models remain separate", { skip }, async () => {
  const merchantId = await merchant();
  await listing(merchantId, "  Test   Phone ", null, { brand:"Acme", model:"A1" });
  await rejectedDuplicate(listing(merchantId, "test phone", "", { brand:"ACME", model:"a1" }));
  await listing(merchantId, "Test Phone", null, { brand:"Acme", model:"A2" });
  await listing(merchantId, "Test Phone", "DIFFERENT-SKU", { brand:"Acme", model:"A1" });
});

test("archived products can be replaced, but stale duplicates cannot be reactivated", { skip }, async () => {
  const merchantId = await merchant();
  const original = await listing(merchantId, "Archive Product", "TO-ARCHIVE");
  await pool.query("update products set status='archived' where id=$1", [original]);
  await listing(merchantId, "Archive Product Replacement", "to-archive");
  await rejectedDuplicate(pool.query("update products set status='pending_review' where id=$1", [original]));
});

test("simultaneous duplicate submissions result in at most one new listing", { skip }, async () => {
  const merchantId = await merchant();
  const submitted = await Promise.allSettled([
    listing(merchantId, "Concurrent Item", "shared-merchant-sku"),
    listing(merchantId, "Concurrent Item Again", " SHARED-MERCHANT-SKU "),
  ]);
  assert.equal(submitted.filter(x => x.status === "fulfilled").length, 1);
  const rejected = submitted.find(x => x.status === "rejected");
  assert.equal(rejected?.reason?.code, "23505");
  const rows = await pool.query("select count(*)::int as n from products where merchant_id=$1 and catalog_duplicate_key(sku)='shared-merchant-sku'", [merchantId]);
  assert.equal(rows.rows[0].n, 1);
});

test("merchant categories cannot repeat the same catalogue key", { skip }, async () => {
  const merchantId = await merchant();
  await assert.rejects(
    pool.query("update merchants set catalog_categories=array['electronics','electronics']::text[] where id=$1", [merchantId]),
    (error) => {
      assert.equal(error.code, "23514");
      assert.match(error.message, /Merchant catalog categories must be unique/);
      return true;
    },
  );
  const result = await pool.query("select catalog_categories from merchants where id=$1", [merchantId]);
  assert.deepEqual(result.rows[0].catalog_categories, ["electronics"]);
});

test("bulk CSV insert is atomic when a row duplicates an earlier row", { skip }, async () => {
  const merchantId = await merchant();
  const userId = id("dup_user");
  await pool.query(`insert into "user"(id,name,email,"emailVerified")
    values($1,'CSV Merchant',$2,true)`, [userId, userId + "@integration.test"]);
  await pool.query(`insert into merchant_accounts(merchant_id,user_id,status)
    values($1,$2,'active')`, [merchantId,userId]);
  const rows = [
    { name:"CSV One",category:"electronics",listingType:"product",price:100,stock:2,sku:"CSV-001" },
    { name:"CSV Duplicate",category:"electronics",listingType:"product",price:120,stock:2,sku:"csv-001" },
  ];
  await rejectedDuplicate(pool.query(
    "select merchant_bulk_create_products($1,$2,$3::jsonb)",
    [merchantId,userId,JSON.stringify(rows)],
  ));
  const result = await pool.query("select count(*)::int n from products where merchant_id=$1", [merchantId]);
  assert.equal(result.rows[0].n, 0, "entire invalid batch must roll back");
});

test("non-identity updates to historical duplicates remain possible", { skip }, async () => {
  const merchantId = await merchant();
  const product = await listing(merchantId, "Stable Item", "STABLE-SKU");
  await pool.query("update products set price=price+1, stock=stock+1 where id=$1", [product]);
  const row = await pool.query("select price::text,stock from products where id=$1", [product]);
  assert.equal(Number(row.rows[0].price), 101);
  assert.equal(Number(row.rows[0].stock), 6);
});
