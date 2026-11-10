import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { loadTypeScript } from "../scripts/helpers/load-typescript.mjs";

const { SignedHttpPayoutDriver } = loadTypeScript("src/modules/wallet/internal/adapters/signed-http.ts");
const { configuredPayoutFee, maskAccount } = loadTypeScript("src/modules/wallet/internal/adapters/payout.ts");
// Each loadTypeScript call evaluates a fresh module, so compare errors by name.
const isProviderError = (error, rejected) => error?.name === "PayoutProviderError" && (rejected === undefined || error.rejected === rejected);

const SECRET = "s".repeat(40);
const PAYOUT_ID = `wpo_${"a".repeat(32)}`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function driverWith(handler) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, ...init });
    return handler({ url, ...init });
  };
  return { driver: new SignedHttpPayoutDriver("signed-http", "https://payouts.example.com/v1", SECRET, transport, { env: { ELEMARKET_PAYOUT_FEE_FLAT: "1.50" } }), calls };
}

const command = { payoutId: PAYOUT_ID, idempotencyKey: PAYOUT_ID, amount: "98.50", currency: "GHS", rail: "mobile_money", destinationRef: "dst_123", narration: "ELEMARKET payout" };

test("every payout command is HMAC-signed over method, path and body, with the payout id as idempotency key", async () => {
  const { driver, calls } = driverWith(() => json(200, { providerReference: "prv_1", status: "processing" }));
  const state = await driver.createPayout(command);
  assert.deepEqual(state, { providerReference: "prv_1", status: "processing" });
  const call = calls[0];
  assert.equal(call.url, "https://payouts.example.com/v1/payouts");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["idempotency-key"], PAYOUT_ID);
  assert.deepEqual(JSON.parse(call.body), { payoutId: PAYOUT_ID, amount: "98.50", currency: "GHS", rail: "mobile_money", destinationRef: "dst_123", narration: "ELEMARKET payout" });
  const [, t, v1] = call.headers["x-elemarket-signature"].match(/^t=(\d+),v1=([a-f0-9]{64})$/);
  const expected = createHmac("sha256", SECRET).update(`${t}.POST./v1/payouts.${call.body}`).digest("hex");
  assert.equal(v1, expected);
});

test("a duplicate (409) is read back instead of creating a second transfer", async () => {
  const { driver, calls } = driverWith(({ method }) =>
    method === "POST" ? json(409, { error: "duplicate" }) : json(200, { providerReference: "prv_1", status: "paid", amount: "98.50", currency: "GHS" }));
  const state = await driver.createPayout(command);
  assert.equal(state.status, "paid");
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].url, `https://payouts.example.com/v1/payouts/${PAYOUT_ID}`);
});

test("only a validation refusal counts as definitely not sent", async () => {
  for (const [status, rejected] of [[400, true], [422, true], [500, false], [503, false], [401, false]]) {
    const { driver } = driverWith(() => json(status, {}));
    await assert.rejects(driver.createPayout(command), (error) => isProviderError(error, rejected), `HTTP ${status}`);
  }
  const { driver: offline } = driverWith(() => { throw new Error("socket hang up"); });
  await assert.rejects(offline.createPayout(command), (error) => isProviderError(error, false), "network failure");
});

test("malformed provider responses are refused", async () => {
  const { driver } = driverWith(() => json(200, { status: "done" }));
  await assert.rejects(driver.createPayout(command), (error) => isProviderError(error));
  const { driver: lookup } = driverWith(() => json(404, {}));
  assert.equal(await lookup.getPayout(PAYOUT_ID, null), null);
});

test("webhook signatures: valid, tampered, stale", async () => {
  const { driver } = driverWith(() => json(200, {}));
  const raw = JSON.stringify({ payoutId: PAYOUT_ID, providerReference: "prv_1" });
  const t = Math.floor(Date.now() / 1000);
  const sig = (time, body) => `t=${time},v1=${createHmac("sha256", SECRET).update(`${time}.${body}`).digest("hex")}`;
  assert.equal(await driver.verifyWebhook(raw, sig(t, raw)), true);
  assert.equal(await driver.verifyWebhook(raw.replace("prv_1", "prv_2"), sig(t, raw)), false);
  assert.equal(await driver.verifyWebhook(raw, sig(t - 600, raw)), false);
  assert.equal(await driver.verifyWebhook(raw, null), false);
  assert.deepEqual(await driver.parseWebhook(raw), { payoutId: PAYOUT_ID, providerReference: "prv_1" });
  await assert.rejects(driver.parseWebhook(JSON.stringify({ payoutId: "../../admin" })));
});

test("driver configuration fails closed", () => {
  assert.throws(() => new SignedHttpPayoutDriver("signed-http", "http://payouts.example.com", SECRET, async () => json(200, {})), /HTTPS/);
  assert.throws(() => new SignedHttpPayoutDriver("signed-http", "https://payouts.example.com", "short", async () => json(200, {})), /32 characters/);
});

test("transfer fee: flat + basis points, rounded up to the pesewa", () => {
  assert.equal(configuredPayoutFee("100.00", {}), "0.00");
  assert.equal(configuredPayoutFee("100.00", { ELEMARKET_PAYOUT_FEE_FLAT: "1.00" }), "1.00");
  assert.equal(configuredPayoutFee("100.00", { ELEMARKET_PAYOUT_FEE_BPS: "150" }), "1.50");
  assert.equal(configuredPayoutFee("33.33", { ELEMARKET_PAYOUT_FEE_FLAT: "0.50", ELEMARKET_PAYOUT_FEE_BPS: "100" }), "0.84");
  assert.throws(() => configuredPayoutFee("10.00", { ELEMARKET_PAYOUT_FEE_BPS: "5000" }));
  assert.throws(() => configuredPayoutFee("-1", {}));
  assert.equal(maskAccount("+233241234567"), "•••• 4567");
});
