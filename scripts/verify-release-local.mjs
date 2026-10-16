import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';

if(!process.versions.node.startsWith('22.'))throw new Error('Run release verification with Node 22');
const npmCli=process.env.npm_execpath;
if(!npmCli)throw new Error('Invoke through npm exec or npm run');
mkdirSync('verification',{recursive:true});
const checks=[
 ['typecheck',[npmCli,'run','typecheck']],
 ['lint',[npmCli,'run','lint']],
 ['architecture',[npmCli,'run','check:architecture']],
 ['module-contracts',['scripts/check-module-contracts.mjs']],
 ['provider-neutrality',['scripts/check-provider-neutrality.mjs']],
 ['migration-integrity',['scripts/validate-deployment-package.mjs']],
 ['unit',[npmCli,'test']],
 ['fulfillment-postgres',['--test','tests/fulfillment.postgres.mjs']],
 ['build',[npmCli,'run','build']],
];
const results=[];
for(const [name,args] of checks){
 const start=new Date().toISOString();
 const r=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:32*1024*1024,env:process.env});
 writeFileSync(`verification/final-${name}.log`,`${r.stdout??''}\n${r.stderr??''}`);
 results.push({name,executable:process.execPath,args,node:process.version,startedAt:start,finishedAt:new Date().toISOString(),exitCode:r.status,error:r.error?.message});
 writeFileSync('verification/final-checks.json',JSON.stringify(results,null,2)+'\n');
 console.log(`${r.status===0?'PASS':'FAIL'} ${name} (${r.status})`);
}
process.exitCode=results.some(r=>r.exitCode!==0)?1:0;
