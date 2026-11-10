import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { toPesewas, fromPesewas, formatGhs, lineTotal, sumMoney, quoteDelivery } from "../src/modules/shared/internal/money.ts";
import { formatOrderCursor, parseOrderCursor } from "../src/modules/ordering/internal/order-cursor.ts";
import { nonRelevanceCursorPredicate } from "../src/modules/catalog/internal/search-cursor.ts";
import { deterministicPaymentReference, moneyToMinorUnits } from "../src/modules/payments/internal/payment-reference.ts";

test("pesewa conversion rejects negatives, extra precision, and unsafe magnitudes", () => {
  assert.equal(toPesewas("10.10"), 1010);
  assert.equal(toPesewas("0.1"), 10);
  assert.equal(fromPesewas(1010), "10.10");
  assert.equal(formatGhs("19.99"), "GH₵ 19.99");
  assert.equal(formatGhs("-1.00"), "GH₵ —");
  assert.throws(() => toPesewas("-0.01"));
  assert.throws(() => toPesewas("1.005"));
  assert.throws(() => toPesewas(Number.NaN));
});

test("line and cart totals stay on integer pesewas", () => {
  assert.equal(lineTotal("0.10", 3), "0.30");
  assert.equal(lineTotal("19.99", 3), "59.97");
  assert.equal(sumMoney(["0.10", "0.20", "0.30"]), "0.60");
  assert.equal(sumMoney([lineTotal("0.10", 3), lineTotal("19.99", 1)]), "20.29");
  const cart = readFileSync(new URL("../src/modules/ordering/internal/cart.ts", import.meta.url), "utf8");
  assert.match(cart, /toPesewas\(line\.price\) \* line\.quantity/);
  assert.doesNotMatch(cart, /Number\(line\.price\) \* 100/);
});

test("delivery quotes are priced in whole pesewas", () => {
  const quote = quoteDelivery("next_day", 1.005);
  assert.match(quote.price, /^\d+\.\d{2}$/);
  assert.equal(toPesewas(quote.price) >= 1800, true);
  const far = quoteDelivery("same_day", 1000);
  assert.equal(far.price, "180.00");
  assert.equal(far.distanceKm, 100);
});

test("order cursors keep rows that share a timestamp", () => {
  const cursor = formatOrderCursor("2026-11-10 11:07:00.123456+00", "ord_b");
  assert.deepEqual(parseOrderCursor(cursor), { at: "2026-11-10 11:07:00.123456+00", id: "ord_b" });
  assert.deepEqual(parseOrderCursor("2026-11-10 11:07:00+00"), { at: "2026-11-10 11:07:00+00", id: null });
  assert.equal(parseOrderCursor(null).at, null);
});

test("price and newest search cursors are balanced SQL", () => {
  for (const sort of ["price_asc", "price_desc", "newest"]) {
    const sql = nonRelevanceCursorPredicate(sort, "$1", "$2", "$3", "$4");
    const opens = [...sql].filter((char) => char === "(").length;
    const closes = [...sql].filter((char) => char === ")").length;
    assert.equal(opens, closes, sql);
    assert.match(sql, /id>\$4/);
  }
  assert.match(nonRelevanceCursorPredicate("price_asc", "$1", "$2", "$3", "$4"), /_key>\$2/);
  assert.match(nonRelevanceCursorPredicate("newest", "$1", "$2", "$3", "$4"), /_key<\$2/);
});

test("payment references and commission minor units are deterministic", () => {
  assert.equal(deterministicPaymentReference("pat_abc12345"), "patabc12345");
  assert.equal(moneyToMinorUnits("10.5"), 1050);
  assert.equal(moneyToMinorUnits("0.00"), 0);
  assert.throws(() => moneyToMinorUnits("-1.00"));
  assert.throws(() => deterministicPaymentReference("bad"));
});

test("checkout migration keeps the inventory and discount invariants", () => {
  const sql = readFileSync(new URL("../migrations/0214_logic_checkout_inventory_and_money.sql", import.meta.url), "utf8");
  for (const needle of [
    "payment_deadline",
    "elemarket_restore_reservation_stock",
    "v_now + interval '15 minutes'",
    "return window has not started",
    "sold_quantity=greatest(sold_quantity-q.quantity,0)",
    "v_product_total + v_delivery <= 0",
    "v_remaining_discount",
  ]) {
    assert.equal(sql.includes(needle), true, needle);
  }
  assert.equal(sql.includes("ceil("), false);
});

test("checkout empty-order guard uses this merchant's delivery fee", () => {
  // The newest migration defining create_pending_order is the one in force.
  const dir = new URL("../migrations/", import.meta.url);
  const latest = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => /function\s+public\.create_pending_order\s*\(/i.test(readFileSync(new URL(name, dir), "utf8")))
    .at(-1);
  assert.equal(latest, "0215_checkout_empty_order_guard.sql");
  const sql = readFileSync(new URL(latest, dir), "utf8");
  const assigned = sql.indexOf("v_delivery:=v_quote.price;");
  const guard = sql.indexOf("v_product_total + v_delivery <= 0");
  assert.ok(assigned > 0 && guard > assigned, "v_delivery must be assigned before the empty-order guard");
  assert.equal(sql.split("v_delivery:=v_quote.price;").length - 1, 1, "single assignment per merchant");
  assert.match(sql, /v_delivery is null or v_delivery <= 0 then raise exception 'invalid delivery quote price'/);
});
