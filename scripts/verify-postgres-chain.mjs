import {readFileSync, readdirSync, mkdirSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

// Explicit isolated database only; never defaults to application DATABASE_URL.
const database = process.env.ELEMARKET_TEST_DATABASE;
if (!/^elemarket_test_[a-z0-9_]+$/.test(database ?? '')) throw new Error('ELEMARKET_TEST_DATABASE must name an isolated elemarket_test_* database');
const args = ['-X','-h','127.0.0.1','-p',process.env.ELEMARKET_TEST_PORT ?? '55439','-U','elemarket_test','-d',database,'-v','ON_ERROR_STOP=1'];
const manifest = JSON.parse(readFileSync('migrations.sha256.json','utf8'));
const through=process.env.ELEMARKET_TEST_THROUGH ?? '9999';
if(!/^\d{4}$/.test(through))throw new Error('Invalid historical boundary');
const files = readdirSync('migrations').filter(n=>n.endsWith('.sql') && n.slice(0,4)<=through).sort();
mkdirSync('verification',{recursive:true});
const results=[];
const setup=spawnSync('psql',args,{input:'CREATE TABLE _migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now(),checksum text);',encoding:'utf8'});
if(setup.status!==0)throw new Error(setup.stderr ?? 'Database must be fresh');
for (const name of files) {
  const sql=readFileSync(`migrations/${name}`,'utf8');
  const digest=createHash('sha256').update(sql).digest('hex');
  if(manifest[name]!==digest) throw new Error(`Checksum mismatch: ${name}`);
  if(!/^[a-zA-Z0-9_.-]+$/.test(name))throw new Error('Unexpected migration filename');
  const result=spawnSync('psql',args,{input:`BEGIN;\n${sql}\nINSERT INTO _migrations(name,checksum) VALUES('${name}','${digest}');\nCOMMIT;\n`,encoding:'utf8',maxBuffer:16*1024*1024});
  results.push({name,sha256:digest,status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message});
  console.log(`${result.status===0?'PASS':'FAIL'} ${name}`);
  writeFileSync(`verification/${database}-migration-results.json`,JSON.stringify(results,null,2));
  if(result.status!==0){ console.error(result.stderr ?? result.error);process.exit(1); }
}
console.log(`PASS: ${results.length} PostgreSQL migration transactions. This verifies SQL execution, not the production migration runner or business behavior.`);
