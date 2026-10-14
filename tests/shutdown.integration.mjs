import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import http from 'node:http';
const database=process.env.DATABASE_URL;
if(!database || new URL(database).hostname!=='127.0.0.1' || !new URL(database).pathname.endsWith('_test') || process.env.ELEMARKET_DOMAIN!=='elemarket.localhost') throw new Error('Explicit synthetic local database and portal required');
const server=spawn(process.execPath,['scripts/start.mjs'],{env:{...process.env,NITRO_PORT:'8083'},stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',chunk=>logs+=chunk);server.stderr.on('data',chunk=>logs+=chunk);
const exited=new Promise(resolve=>server.once('exit',(code,signal)=>resolve({code,signal})));
let child;
function health(){return new Promise((resolve,reject)=>{const request=http.get({hostname:'127.0.0.1',port:8083,path:'/api/health',headers:{host:process.env.ELEMARKET_DOMAIN,'x-forwarded-for':'127.0.0.1'},agent:false},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,body}));});request.setTimeout(1000,()=>request.destroy());request.on('error',reject);});}
try {
 let ready;
 for(let n=0;n<50;n++){try{ready=await health();if(ready.status===200)break;}catch{ /* Retry while the listener starts. */ }await new Promise(resolve=>setTimeout(resolve,200));}
 assert.equal(ready?.status,200,'Production entrypoint did not become ready');
 assert.deepEqual(JSON.parse(ready.body).checks,{database:'ok',cache:'ok'});
 child=Number(readFileSync(`/proc/${server.pid}/task/${server.pid}/children`,'utf8').trim());
 assert.ok(child>0,'Expected one Nitro child process');
 const started=Date.now();server.kill('SIGTERM');
 let timer;
 const result=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),8000);})]);clearTimeout(timer);
 assert.deepEqual(result,{code:0,signal:null},'Server must exit cleanly after draining HTTP/Redis/PostgreSQL');
 assert.equal(existsSync(`/proc/${child}`),false,'Nitro child must not survive its launcher');
 console.log(`PASS: production startup, PostgreSQL/Redis health and SIGTERM exit in ${Date.now()-started} ms; no orphan child`);
}finally{
 if(server.exitCode===null && server.signalCode===null){server.kill('SIGKILL');if(child)try{process.kill(child,'SIGKILL');}catch{ /* Child already exited during cleanup. */ }}
}
