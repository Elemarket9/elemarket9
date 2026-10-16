// Legacy command retained; execute current behavioral EIDE regressions.
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
const tests=readdirSync('tests').filter(n=>n.startsWith('eide')&&n.endsWith('.test.mjs')).map(n=>'tests/'+n);
if (!tests.length) throw new Error('No EIDE tests found; refusing an empty verification gate');
const result=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit'});
process.exit(result.status??1);
