import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypeScript} from '../scripts/helpers/load-typescript.mjs';
const {classifyQueryIntent,correctDiscoveryQuery,meaningfulTokens}=loadTypeScript('src/modules/catalog/internal/eide/intelligence.ts');
test('EIDE preserves hard price limits and distinguishes a soft budget',()=>{
 const hard=classifyQueryIntent('phones under GH₵ 2,000');
 assert.equal(hard.hardPriceCeiling,2000);assert.equal(hard.normalized,'phones');
 const soft=classifyQueryIntent('laptop budget 5000');
 assert.equal(soft.priceCeiling,5000);assert.equal(soft.hardPriceCeiling,undefined);
 const range=classifyQueryIntent('TV between GHS 1000 and GHS 2000');
 assert.equal(range.hardPriceFloor,1000);assert.equal(range.hardPriceCeiling,2000);
});
test('EIDE only corrects unambiguous vocabulary typos and bounds token expansion',()=>{
 assert.equal(correctDiscoveryQuery('samsng',{brands:['Samsung']}),'samsung');
 assert.equal(correctDiscoveryQuery('abcdef',{brands:['abcdeg','abcdeh']}),'abcdef');
 const words=Array.from({length:100},(_,i)=>`word${i}`).join(' ');
 assert.equal(meaningfulTokens(words).length,24);
 assert.deepEqual(meaningfulTokens('the phone phone and TV'),['phone','tv']);
});
