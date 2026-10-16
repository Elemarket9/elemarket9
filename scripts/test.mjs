import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Node 22 can report success for an unmatched glob. Release gates must fail
// when a suite was accidentally omitted from a source package.
const prefixArg = process.argv.find(arg => arg.startsWith('--prefix='));
const prefix = prefixArg?.slice('--prefix='.length) ?? '';
if (prefixArg && !/^[a-z0-9-]+$/.test(prefix)) throw new Error('Invalid test suite prefix');
const files = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.mjs') && name !== 'integration.test.mjs' && name.startsWith(prefix))
  .sort().map(name => `tests/${name}`);
if (!files.length) throw new Error(`No ${prefix || 'unit'} tests found; refusing an empty verification gate`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
