import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript } from "../scripts/helpers/load-typescript.mjs";

const { requireServerCheckoutUrl } = loadTypeScript("mobile/src/payment-url.ts");

test("server-returned checkout links preserve legitimate opaque HTTPS parameters", () => {
  const checkout = "https://checkout.example.com/pay?reference=abc%2F12&token=c29tZQ";
  assert.equal(requireServerCheckoutUrl(checkout), checkout);
  assert.equal(requireServerCheckoutUrl("https://checkout.example.com:443/pay"), "https://checkout.example.com:443/pay");
});

test("checkout never opens insecure, credential-bearing, or non-URL input", () => {
  for (const link of [
    undefined, null, "", "/checkout", "//attacker.example/pay",
    "javascript:alert(1)", "data:text/html,hello", "http://checkout.example.com",
    "https://user:pass@checkout.example.com/pay", "https://checkout.example.com:444/pay",
    "https://checkout.example.com/\\nnext", "https://checkout.example.com/\nnext",
    "https://checkout.example.com/\rnext",
  ]) {
    assert.throws(() => requireServerCheckoutUrl(link), undefined, String(link));
  }
});
