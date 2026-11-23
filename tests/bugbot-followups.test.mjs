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
  const dir = new URL("../migrations/", import.meta.url);
  const names = readFileSync(new URL("../migrations.sha256.json", import.meta.url), "utf8");
  const files = [...names.matchAll(/"(\d{4}_[^"]+\.sql)"/g)].map((match) => match[1]);
  let latest = "";
  for (const name of files) {
    const sql = readFileSync(new URL(name, dir), "utf8");
    if (/create or replace function public\.create_pending_order/i.test(sql)) latest = sql;
  }
  const fn = latest.slice(latest.toLowerCase().indexOf("create_pending_order"));
  const guard = fn.indexOf("v_product_total + v_delivery <= 0");
  const assign = Math.max(fn.lastIndexOf("v_delivery := v_quote.price", guard), fn.lastIndexOf("v_delivery:=v_quote.price", guard));
  assert.ok(guard > 0 && assign > 0 && assign < guard);
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
