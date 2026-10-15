#!/usr/bin/env node
import { readFileSync } from "node:fs";

// Generic build gate: adapter-specific browser configuration lives in the
// provider registry, not in marketplace build policy.
const registry = JSON.parse(readFileSync(new URL("../config/provider-capabilities.json", import.meta.url), "utf8"));
const serverProvider = (process.env.ELEMARKET_PUSH_PROVIDER ?? "").trim().toLowerCase();
const browserProvider = (process.env.VITE_ELEMARKET_PUSH_PROVIDER ?? "").trim().toLowerCase();

if (!serverProvider && !browserProvider) {
  console.log("[push] push disabled: no provider selected for this deployment.");
  process.exit(0);
}
if (!serverProvider || browserProvider !== serverProvider) {
  console.error("[push] browser and server push provider selections must agree.");
  process.exit(1);
}
const descriptor = registry.push?.[serverProvider];
if (!descriptor || !Array.isArray(descriptor.clientRequiredEnv)) {
  console.error("[push] selected browser push adapter has no registered build requirements.");
  process.exit(1);
}
const required = descriptor.clientRequiredEnv;
if (required.some(key => !/^VITE_[A-Z0-9_]+$/.test(key))) {
  console.error("[push] invalid browser build registry requirements.");
  process.exit(1);
}
const missing = required.filter(key => !process.env[key]?.trim());
if (missing.length) {
  console.error(`[push] missing browser push build configuration: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("[push] selected browser push adapter build configuration validated.");
