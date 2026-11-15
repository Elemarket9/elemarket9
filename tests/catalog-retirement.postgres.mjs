// Regression coverage for retirement of prepared-food and restaurant catalogue.
// PostgreSQL only: use a disposable *_test DB, never the production database.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createMigratedTestDatabase, integrationDatabaseUrl } from "../scripts/helpers/pg-test-database.mjs";

const enabled = Boolean(integrationDatabaseUrl());
const skip = !enabled && "Requires disposable PostgreSQL integration database";
let db, pool;
const id = (prefix) => prefix + "_" + randomUUID().replaceAll("-", "");
before(async () => {
  if (!enabled) return;
  db = await createMigratedTestDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 3 });
});
after(async () => {
  await pool?.end();
  await db?.drop();
});

test("food and restaurant taxonomy are inactive; groceries remain active", { skip }, async () => {
  const result = await pool.query(
    "select category_key,active from category_taxonomy where category_key=any($1::text[])",
    [["food", "restaurants", "groceries"]],
  );
  const flags = Object.fromEntries(result.rows.map(row => [row.category_key, row.active]));
  assert.deepEqual(flags, { food: false, restaurants: false, groceries: true });
  const section = await pool.query("select section_key from homepage_sections where section_key='food_spotlight'");
  assert.equal(section.rows.length, 0);
  await assert.rejects(
    pool.query("update category_taxonomy set active=true where category_key='food'"),
    error => {
      assert.equal(error.code, "23514");
      return true;
    },
  );
});

test("historical food products are preserved but archived", { skip }, async () => {
  const rows = await pool.query("select category,listing_type,status from products where id='p_jollof'");
  assert.equal(rows.rows.length, 1, "historical fixture retains its product identity");
  assert.equal(rows.rows[0].status, "archived");
});

async function newMerchant(category) {
  const merchantId = id("retired_mer");
  await pool.query(`insert into merchants(
     id,name,category,catalog_categories,status,verified,tier,address,city,neighborhood,lat,lon)
   values($1,'Catalogue Retirement Merchant',$2,array[$2]::text[],'active',true,
          'merchant','1 Test Street','Accra','Osu',5.6,-0.18)`,
   [merchantId,category]);
  return merchantId;
}
async function newProduct(merchantId, category, listingType) {
  return pool.query(`insert into products(id,merchant_id,name,category,listing_type,price,currency,stock,description,status)
    values($1,$2,'Retirement Test Product',$3,$4,120,'GHS',2,'retirement test','pending_review')`,
    [id("retired_prod"),merchantId,category,listingType]);
}

test("new prepared-food merchants and listings are refused across SQL entry points", { skip }, async () => {
  await assert.rejects(newMerchant("restaurants"), error => {
    assert.equal(error.code, "23514");
    assert.match(error.message, /retired from ELEMARKET/);
    return true;
  });
  const merchantId = await newMerchant("electronics");
  for (const [category, type] of [
    ["food", "product"],
    ["restaurants", "product"],
    ["electronics", "food"],
  ]) {
    await assert.rejects(newProduct(merchantId, category, type), error => {
      assert.equal(error.code, "23514");
      assert.match(error.message, /retired from ELEMARKET/);
      return true;
    });
  }
});

test("groceries and ordinary marketplace products remain supported", { skip }, async () => {
  const merchantId = await newMerchant("groceries");
  await newProduct(merchantId, "groceries", "product");
  const rows = await pool.query("select count(*)::int n from products where merchant_id=$1", [merchantId]);
  assert.equal(rows.rows[0].n, 1);
});
