// Legacy command retained; execute current behavioral EIDE regressions.
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
const result=spawnSync(process.execPath,['--test',...readdirSync('tests').filter(n=>n.startsWith('eide')&&n.endsWith('.test.mjs')).map(n=>'tests/'+n)],{stdio:'inherit'});
process.exit(result.status??1);
