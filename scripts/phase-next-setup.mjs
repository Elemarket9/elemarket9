import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
mkdirSync('verification/phase-next',{recursive:true});
const manifest=JSON.parse(readFileSync('migrations.sha256.json'));
for(const [name,expected] of Object.entries(manifest)){
 const actual=createHash('sha256').update(readFileSync(`migrations/${name}`)).digest('hex');
 if(actual!==expected)throw new Error(`Historical migration drift: ${name}`);
}
for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql'))){
 if(!manifest[name])manifest[name]=createHash('sha256').update(readFileSync(`migrations/${name}`)).digest('hex');
}
writeFileSync('migrations.sha256.json',JSON.stringify(manifest,null,2)+'\n');
for(const [command,args] of [
 ['pg_ctl',['-D','.verification-postgres','-l','verification/phase-next/postgres.log','-o','-h 127.0.0.1 -p 55439','-w','start']],
 ['createdb',['-h','127.0.0.1','-p','55439','-U','elemarket_test','elemarket_test_next']],
]){
 if(command==='pg_ctl' && spawnSync('pg_isready',['-h','127.0.0.1','-p','55439','-U','elemarket_test'],{stdio:'ignore'}).status===0)continue;
 const r=spawnSync(command,args,{stdio:'ignore',timeout:30000});console.log(command,r.status);
}
const r=spawnSync(process.execPath,['scripts/migrate.mjs'],{env:{...process.env,DATABASE_URL:'postgresql://elemarket_test@127.0.0.1:55439/elemarket_test_next'},encoding:'utf8'});
writeFileSync('verification/phase-next/fresh-migrations.log',(r.stdout??'')+(r.stderr??''));
console.log(r.stdout?.split('\n').slice(-10).join('\n'),r.stderr);process.exitCode=r.status??1;
