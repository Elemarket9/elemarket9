import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypeScript} from '../scripts/helpers/load-typescript.mjs';
import * as portals from '../src/lib/security/portal-policy.mjs';
const {securityHeaders}=loadTypeScript('src/lib/security/headers.ts');
const {startInstance}=loadTypeScript('src/start.ts',{
 '@tanstack/react-start':{createMiddleware:()=>({server:fn=>fn}),createCsrfMiddleware:()=>{},createStart:build=>build()},
 '@/lib/security/portal-policy.mjs':portals,'@/lib/security/headers':{securityHeaders},
});
const middleware=startInstance.requestMiddleware.at(-1);
test('final SSR responses preserve the matching CSP nonce on loader errors and success',async()=>{
 const nonces=[];
 for(const status of [200,500]){
  let nonce;
  const result=await middleware({next:async({context})=>{
   nonce=context.cspNonce;
   return {context,response:new Response(`<script nonce="${nonce}">bootstrap()</script>`,{status,headers:{'content-type':'text/html','x-test-response':'preserved'}})};
  }});
  assert.equal(result.response.status,status);
  assert.equal(result.response.headers.get('x-test-response'),'preserved');
  assert.ok(result.response.headers.get('content-security-policy').includes(`'nonce-${nonce}'`));
  assert.ok(!result.response.headers.get('content-security-policy').includes("script-src 'unsafe-inline'"));
  assert.equal(await result.response.text(),`<script nonce="${nonce}">bootstrap()</script>`);
  nonces.push(nonce);
 }
 assert.notEqual(nonces[0],nonces[1]);
});
