import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapWithConcurrency } from "../src/lib/bounded-map.mjs";

test("content security policy allows style attributes and not inline scripts", () => {
  const headers = readFileSync(new URL("../src/lib/security/headers.ts", import.meta.url), "utf8");
  assert.match(headers, /style-src-attr 'unsafe-inline'/);
  assert.doesNotMatch(headers, /script-src[^;\n]*'unsafe-inline'/);
});

test("checkout assigns this merchant's delivery fee before the empty-order guard", () => {
  const sql = readFileSync(new URL("../migrations/0215_checkout_delivery_fee_per_merchant.sql", import.meta.url), "utf8");
  const fn = sql.slice(sql.indexOf("create_pending_order"));
  const assign = fn.indexOf("v_delivery := v_quote.price");
  const guard = fn.indexOf("v_product_total + v_delivery <= 0");
  assert.ok(assign > 0 && guard > assign);
  assert.equal(fn.slice(guard).includes("v_delivery := v_quote.price"), false);
  assert.equal(fn.slice(guard).includes("v_delivery:=v_quote.price"), false);
});

test("homepage section loads stay under the discovery pool", async () => {
  const db = readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8");
  const home = readFileSync(new URL("../src/modules/catalog/internal/homepage.functions.ts", import.meta.url), "utf8");
  const pool = Number(/lane === "discovery" \? (\d+)/.exec(db)?.[1]);
  const cap = Number(/HOMEPAGE_SECTION_CONCURRENCY = (\d+)/.exec(home)?.[1]);
  assert.ok(pool >= 4 && cap >= 1 && cap < pool);
  assert.match(home, /mapWithConcurrency\(configs, HOMEPAGE_SECTION_CONCURRENCY/);
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], cap, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, cap);
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
});
