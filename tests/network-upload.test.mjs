import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypeScript} from '../scripts/helpers/load-typescript.mjs';

// Deterministic DNS/provider boundaries; these are module tests, not cloud
// storage certification or external penetration tests.
function network(answers){return loadTypeScript('src/lib/security/ssrf.server.ts',{'node:dns/promises':{lookup:async()=>answers}});}
test('SSRF rejects encoded loopback, private IPv4/IPv6 and mixed DNS answers',async()=>{
 const api=network([{address:'93.184.216.34',family:4}]);
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','64:ff9b::a00:1','2002:7f00:1::']) assert.equal(api.isPrivateOrReservedIp(address),true,address);
 for(const endpoint of ['http://example.test','https://localhost','https://2130706433','https://0x7f000001','https://[::ffff:127.0.0.1]','https://user:password@example.test','https://example.test:8443']) await assert.rejects(api.assertPublicHttpsEndpoint(endpoint));
 await assert.rejects(network([{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}]).assertPublicHttpsEndpoint('https://example.test'),/private or reserved/);
 await assert.rejects(network([]).assertPublicHttpsEndpoint('https://example.test'),/private or reserved/);
 assert.equal((await api.assertPublicHttpsEndpoint('https://example.test/path')).hostname,'example.test');
});

test('HTTPS transport rejects DNS rebinding before any socket is opened',async()=>{
 let lookups=0,requests=0;
 const dependencies={'node:dns/promises':{lookup:async()=>[{address:++lookups===1?'93.184.216.34':'127.0.0.1',family:4}]},'node:https':{request:()=>{requests++;throw new Error('Unexpected connection');}}};
 const api=loadTypeScript('src/lib/security/pinned-https.server.ts',dependencies);
 await assert.rejects(api.fetchPinnedPublicHttps('https://example.test'),/restricted address/);
 assert.equal(lookups,2);assert.equal(requests,0);
});

function storage(bytes,type='image/png',size=bytes.length){return loadTypeScript('src/lib/storage/storage.server.ts',{'@/lib/db':{},'./registry.server':{getStorageProvider:()=>({headObject:async()=>({sizeBytes:size,contentType:type}),readObject:async()=>bytes})}});}
test('upload policy rejects active content, oversized files and path traversal',()=>{
 const api=storage(new Uint8Array());
 const valid={purpose:'product-image',contentType:'image/png',sizeBytes:32,resourceId:'product_1'};
 assert.doesNotThrow(()=>api.validateUploadPolicy(valid));
 for(const patch of [{contentType:'image/svg+xml'},{contentType:'text/html'},{sizeBytes:573441},{sizeBytes:0},{resourceId:'../other'},{purpose:'unknown'}]) assert.throws(()=>api.validateUploadPolicy({...valid,...patch}));
 assert.throws(()=>api.createStorageObjectKey('../user',valid),/Invalid user/);
 assert.match(api.createStorageObjectKey('user_1',{...valid,extension:'html'}),/\.png$/,'Storage extension is derived from permitted MIME type');
});

test('uploaded object verification rejects mismatched MIME, size and appended scripts',async()=>{
 const jpeg=Buffer.from([255,216,255,217]);
 await storage(jpeg,'image/jpeg').verifyUploadedObject('synthetic',{contentType:'image/jpeg',sizeBytes:4});
 await assert.rejects(storage(jpeg,'text/html').verifyUploadedObject('synthetic',{contentType:'image/jpeg',sizeBytes:4}),/content type/);
 await assert.rejects(storage(jpeg,'image/jpeg',5).verifyUploadedObject('synthetic',{contentType:'image/jpeg',sizeBytes:4}),/size/);
 const polyglot=Buffer.concat([jpeg,Buffer.from('<script>alert(1)</script>')]);
 await assert.rejects(storage(polyglot,'image/jpeg').verifyUploadedObject('synthetic',{contentType:'image/jpeg',sizeBytes:polyglot.length}),/file type/);
 const svg=Buffer.from('<svg onload="alert(1)"></svg>');
 await assert.rejects(storage(svg,'image/png').verifyUploadedObject('synthetic',{contentType:'image/png',sizeBytes:svg.length}),/file type/);
});
