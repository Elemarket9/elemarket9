import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertPayableDeliveryPrice,
  assertDeliveryQuoteBounds,
  marketplaceSettlementChargePesewas,
  quoteCartCanonical,
  sanitizeCspSources,
} from "../src/lib/commerce-guards.mjs";
import { JOBS } from "../scripts/scheduler-core.mjs";

test("delivery quotes reject zero, oversized, and over-long trips", () => {
  assert.equal(assertPayableDeliveryPrice("12.5"), "12.50");
  assert.equal(assertPayableDeliveryPrice("10000"), "10000.00");
  assert.throws(() => assertPayableDeliveryPrice("0"), /Invalid delivery quote amount/);
  assert.throws(() => assertPayableDeliveryPrice("0.00"), /Invalid delivery quote amount/);
  assert.throws(() => assertPayableDeliveryPrice("10000.01"), /Invalid delivery quote amount/);
  assert.throws(() => assertDeliveryQuoteBounds({ price: "20", etaMinutes: 10081, distanceKm: 3 }), /eta/);
  assert.throws(() => assertDeliveryQuoteBounds({ price: "20", etaMinutes: 90, distanceKm: 100.01 }), /distance/);
});

test("settlement charge is the snapshotted commission and never the whole payment", () => {
  assert.equal(marketplaceSettlementChargePesewas("120.00", "8.50"), 850);
  assert.equal(marketplaceSettlementChargePesewas("120.00", "0"), 0);
  assert.throws(() => marketplaceSettlementChargePesewas("20.00", "20.00"), /settlement split/);
  assert.throws(() => marketplaceSettlementChargePesewas("20.00", "20.01"), /settlement split/);
});

test("quote fingerprint is stable, grouped, and independent of line order", () => {
  const first = quoteCartCanonical({
    merchantId: "mer_1",
    address: " 12 Ring Road, Accra ",
    tier: "next_day",
    items: [
      { productId: "p2", variantId: null, quantity: 1 },
      { productId: "p1", variantId: "v1", quantity: 2 },
      { productId: "p1", variantId: "v1", quantity: 1 },
    ],
  });
  const second = quoteCartCanonical({
    merchantId: "mer_1",
    address: "12 Ring Road, Accra",
    tier: "next_day",
    items: [
      { productId: "p1", variantId: "v1", quantity: 3 },
      { productId: "p2", quantity: 1 },
    ],
  });
  assert.equal(first, second);
  assert.equal(first, "v1\nmer_1\n12 Ring Road, Accra\nnext_day\np1\tv1\t3\np2\t\t1");
  assert.equal(createHash("sha256").update(first).digest("hex").length, 64);
  assert.throws(() => quoteCartCanonical({ merchantId: "mer_1", address: "x", tier: "next_day", items: [] }), /cart/);
});

test("csp extras cannot inject unsafe keywords", () => {
  assert.deepEqual(
    sanitizeCspSources("https://cdn.example.com 'unsafe-inline' * data: http://evil.example javascript:alert(1) https://user:pass@cdn.example.com"),
    ["https://cdn.example.com"],
  );
});

test("vercel and render schedules cover the scheduler catalog", () => {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url)));
  const paths = new Set(vercel.crons.map((cron) => cron.path));
  for (const job of JOBS) assert.equal(paths.has(job.path), true, job.path);
  const render = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");
  assert.match(render, /scripts\/scheduler\.mjs/);
});
