#!/usr/bin/env node
/** Regression guard: provider brands belong in integration adapters/registries,
 * deployment configuration and historical migrations—not marketplace rules.
 * The vocabulary is discovered from configured adapters rather than a fixed
 * shopping/payment vendor list in this script.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capabilityConfig = JSON.parse(readFileSync(path.join(root, 'config/provider-capabilities.json'), 'utf8'));
const providerNames = new Set();
for (const [capability, providers] of Object.entries(capabilityConfig)) {
  if (capability.startsWith('$')) continue;
  for (const key of Object.keys(providers)) providerNames.add(key.toLowerCase());
}
function walk(dir) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}
for (const dir of [
  'src/modules/payments/internal/adapters/providers',
  'src/modules/logistics/internal/adapters/providers',
  'src/modules/identity/internal/auth/otp/providers',
  'src/modules/identity/internal/auth/email/providers',
  'src/modules/notifications/internal/notifications/push/providers',
  'src/modules/merchants/internal/kyb/providers',
]) for (const file of walk(path.join(root, dir))) providerNames.add(path.parse(file).name.split('.')[0].toLowerCase());
// Drop generic words that are domain terms rather than vendor identifiers.
for (const generic of ['provider', 'registry', 'index']) providerNames.delete(generic);
const pattern = new RegExp(`\\b(${[...providerNames].filter(n => n.length >= 3).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
function integrationBoundary(relative) {
  return /(^|\/)adapters\/providers\//.test(relative) ||
    /(^|\/)auth\/(otp|email)\/providers\//.test(relative) ||
    /(^|\/)kyb\/providers\//.test(relative) ||
    /(^|\/)notifications\/push\/providers\//.test(relative) ||
    /(^|\/)notifications\/push\/fcm\.client\.ts$/.test(relative) ||
    /(^|\/)notifications\/push\/push\.client\.ts$/.test(relative) ||
    /(^|\/)registry\.server\.ts$/.test(relative) ||
    /(^|\/)email\/webhook\.server\.ts$/.test(relative) ||
    /(^|\/)storage\/r2\.server\.ts$/.test(relative) ||
    /(^|\/)storage\/provider\.ts$/.test(relative) ||
    /(^|\/)adapters\/providers\/.+\.ts$/.test(relative) ||
    /(^|\/)payments\/public\/adapters\/providers\//.test(relative);
}
const failures = [];
for (const file of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'server'))]) {
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  const rel = path.relative(root, file).replaceAll('\\', '/');
  if (integrationBoundary(rel)) continue;
  const text = readFileSync(file, 'utf8');
  // 'resend code' is an ordinary account UX verb, not an email vendor reference.
  const found = text.replace(/\bresend code\b/gi, 'send another code').match(pattern);
  if (found) failures.push(`${rel}: provider name '${found[0]}' outside an adapter/registry boundary`);
}
const startup = readFileSync(path.join(root, 'scripts/validate-startup-env.mjs'), 'utf8');
if (pattern.test(startup)) failures.push('scripts/validate-startup-env.mjs: startup hardcodes a provider brand');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`[provider-neutrality] PASS: no provider brands in marketplace core/startup (${providerNames.size} registered provider identifiers checked).`);
