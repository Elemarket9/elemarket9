// Compatibility command executes every current EIDE regression.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const tests=readdirSync('tests').filter(n=>n.startsWith('eide')&&n.endsWith('.test.mjs')).map(n=>'tests/'+n);
const r=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit'});
process.exit(r.status??1);
