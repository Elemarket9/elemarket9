#!/usr/bin/env node
/**
 * Module contract guard (fix #1 — public/internal drift prevention).
 *
 * Every file under src/modules/<module>/public must be a thin re-export barrel:
 *   - no local implementation (no top-level statements other than re-exports)
 *   - every relative specifier must resolve inside the SAME module
 *   - every re-export target must exist
 *
 * Without this guard, public entry points silently grow full copies of internal
 * implementations again and every security fix has to be applied twice.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesDir = path.join(root, "src/modules");
const violations = [];

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

const resolvable = (target) => ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"].some((ext) => fs.existsSync(target + ext));

for (const mod of fs.readdirSync(modulesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
  const publicDir = path.join(modulesDir, mod, "public");
  if (!fs.existsSync(publicDir)) continue;
  for (const file of walk(publicDir)) {
    const rel = path.relative(root, file);
    const source = fs.readFileSync(file, "utf8");
    const lines = source.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));
    if (!lines.length) {
      violations.push(`${rel}: empty public entry point`);
      continue;
    }
    const exportFrom = /^export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+["']([^"']+)["'];?$/;
    for (const line of lines) {
      const match = line.match(exportFrom);
      if (!match) {
        violations.push(`${rel}: public entry points must be pure re-export barrels (offending: ${line.slice(0, 80)})`);
        continue;
      }
      const specifier = match[1];
      if (!specifier.startsWith(".")) {
        violations.push(`${rel}: public barrels may only use relative specifiers (got '${specifier}')`);
        continue;
      }
      const target = path.resolve(path.dirname(file), specifier);
      const withinModule = path.relative(path.join(modulesDir, mod), target);
      if (withinModule.startsWith("..") || path.isAbsolute(withinModule)) {
        violations.push(`${rel}: re-export escapes module boundary ('${specifier}')`);
      } else if (!resolvable(target)) {
        violations.push(`${rel}: unresolved re-export target '${specifier}'`);
      }
    }
  }
}

if (violations.length) {
  console.error("Module contract violations:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Module contract PASS: all public entry points are thin re-export barrels.");
}
