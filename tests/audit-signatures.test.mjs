import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../scripts/audit-signatures.mjs";

const transient = [
  "npm error code EMISSINGSIGNATUREKEY",
  "npm error set-cookie-parser@3.2.2 has attestations but no corresponding public key(s) can be found",
  "npm error A complete log of this run can be found in: /x.log",
].join("\n");

test("success passes", () => assert.equal(classify("audited 900 packages\n", 0), "ok"));

test("only a missing provenance key is retried", () => assert.equal(classify(transient, 1), "transient"));

test("invalid or missing signatures fail closed", () => {
  assert.equal(classify("npm error code EINTEGRITY\nnpm error 1 package has an invalid registry signature\n", 1), "fail");
  assert.equal(classify("1 package has a missing registry signature but the registry is providing signing keys:\n", 1), "fail");
  assert.equal(classify(`${transient}\nnpm error evil@1.0.0 has an invalid attestation\n`, 1), "fail", "mixed errors never retry");
  assert.equal(classify("", 1), "fail", "unexplained failure");
});
