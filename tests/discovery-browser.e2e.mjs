import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

// Shared Chromium + real local API/database; deterministic migration seed SKU.
// This suite does not submit an order or simulate a successful payment.
const domain=process.env.ELEMARKET_E2E_DOMAIN;
if(!domain?.endsWith('.localhost')) throw new Error('Explicit local ELEMARKET_E2E_DOMAIN required');
const origin=`https://${domain}`;
const browser=(...args)=>{const result=JSON.parse(execFileSync('coderabbit-agent-browser',[...args,'--json'],{encoding:'utf8'}));assert.equal(result.success,true,result.error);return result.data;};
const evaluate=code=>browser('eval',code).result;
const open=path=>browser('--ignore-https-errors','open',`${origin}${path}`);
const wait=condition=>{new Function(`return (${condition})`);return browser('wait','--fn',condition);};
const click=(role,name)=>browser('find','role',role,'click','--name',name,'--exact');
open('/');
const previousCart=evaluate('localStorage.getItem("elemarket:cart:v2")');
try{
 evaluate('localStorage.removeItem("elemarket:cart:v2")');
 for(const width of [1280,390]){
  browser('set','viewport',String(width),'844');open('/');
  browser('find','role','combobox','fill','Wireless earbuds','--name','Search marketplace');
  wait('new URL(location.href).searchParams.get("q")==="Wireless earbuds" && [...document.links].some(a=>a.pathname==="/products/p_earbuds")');
  browser('reload');
  wait('document.querySelector("[role=combobox]")?.value==="Wireless earbuds"');
  assert.equal(evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  click('link','Wireless earbuds');wait('document.querySelector("h1")?.textContent==="Wireless earbuds"');
  assert.equal(evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  click('button','Add to cart');open('/cart');
  wait('document.body.innerText.includes("Wireless earbuds")');
  click('button','Increase quantity of Wireless earbuds · Default');
  assert.equal(evaluate('JSON.parse(localStorage.getItem("elemarket:cart:v2"))[0].quantity'),2);
  browser('reload');wait('document.body.innerText.includes("Wireless earbuds")');
  assert.equal(evaluate('JSON.parse(localStorage.getItem("elemarket:cart:v2"))[0].quantity'),2);
  click('button','Remove Wireless earbuds · Default from cart');
  assert.deepEqual(evaluate('JSON.parse(localStorage.getItem("elemarket:cart:v2"))'),[]);
  assert.equal(evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  console.log(`PASS: search URL/refresh, product detail, cart add/update/reload/remove at ${width}px`);
 }
 open('/');
 const results=evaluate(`(async()=>{const paths=['/api/search?q=earbuds','/api/search?limit=100000','/api/search?lat=999&lon=0','/api/search?minPrice=100&maxPrice=1','/api/search?q='+encodeURIComponent("' OR 1=1--"),'/api/search?q='+encodeURIComponent('<img src=x onerror=alert(1)>')];return Promise.all(paths.map(async path=>{const r=await fetch(path);return {status:r.status,type:r.headers.get('content-type')};}));})()`);
 assert.deepEqual(results.map(x=>x.status),[200,400,400,400,200,200]);
 assert.ok(results.every(x=>x.type?.includes('application/json')));
 console.log('PASS: live search validation rejects invalid limits/coordinates/ranges; injection-like text returns JSON');
 open('/checkout');assert.match(evaluate('document.body.innerText'),/beta/i);
 assert.equal(evaluate('document.querySelectorAll("input[name=cardNumber]").length'),0);
 console.log('PASS: checkout remains explicitly disabled for Developer Beta');
}finally{
 open('/');evaluate(previousCart===null?'localStorage.removeItem("elemarket:cart:v2")':`localStorage.setItem("elemarket:cart:v2",${JSON.stringify(previousCart)})`);
}
