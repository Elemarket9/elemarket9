// Compatibility command executes every current EIDE regression.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const tests=readdirSync('tests').filter(n=>n.startsWith('eide')&&n.endsWith('.test.mjs')).map(n=>'tests/'+n);
if (!tests.length) throw new Error('No EIDE tests found; refusing an empty verification gate');
const r=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit'});
process.exit(r.status??1);
