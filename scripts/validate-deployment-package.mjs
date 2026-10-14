#!/usr/bin/env node
import { readdir, readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const requiredFiles = ["package.json","package-lock.json","migrations.sha256.json","config/provider-capabilities.json","scripts/check-provider-neutrality.mjs","scripts/start.mjs","scripts/migrate.mjs"];
for (const file of requiredFiles) await access(file);
const files = (await readdir("migrations")).filter((n)=>/^\d+.*\.sql$/.test(n)).sort();
const manifest = JSON.parse(await readFile("migrations.sha256.json","utf8"));
const prefixes = new Map();
for (const name of files) {
  const prefix = name.match(/^(\d+)/)?.[1];
  if (!prefix) throw new Error(`Invalid migration filename: ${name}`);
  if (prefixes.has(prefix)) throw new Error(`Duplicate migration prefix ${prefix}: ${prefixes.get(prefix)}, ${name}`);
  prefixes.set(prefix,name);
  const body = await readFile(`migrations/${name}`);
  if (!manifest[name]) throw new Error(`Migration missing from checksum manifest: ${name}`);
  if (manifest[name] !== sha256(body)) throw new Error(`Migration checksum mismatch: ${name}`);
}
for (const name of Object.keys(manifest)) if (!files.includes(name)) throw new Error(`Manifest contains missing migration: ${name}`);
const start = await readFile("scripts/start.mjs","utf8");
if (!start.includes('new URL("./migrate.mjs"')) throw new Error("Production start does not run the locked migration gate");
if (start.indexOf('new URL("./migrate.mjs"') > start.lastIndexOf("findServerEntry()")) throw new Error("Migration gate must run before server startup");
console.log(`[deployment] validated ${files.length} migrations; manifest parity/checksums and portable startup migration gate PASS.`);
