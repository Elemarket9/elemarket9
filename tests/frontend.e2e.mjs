import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

// Uses the customer-visible shared browser. No hidden browser is launched.
// Set ELEMARKET_E2E_DOMAIN to the configured local five-portal domain.
const domain=process.env.ELEMARKET_E2E_DOMAIN;
if(!domain || !domain.endsWith('.localhost')) throw new Error('ELEMARKET_E2E_DOMAIN must be an explicitly selected local *.localhost test domain');
const browser=(...args)=>JSON.parse(execFileSync('coderabbit-agent-browser',[...args,'--json'],{encoding:'utf8'}));
const evaluate=script=>browser('eval',script).data.result;
const navigate=url=>{const r=browser('--ignore-https-errors','open',url);assert.equal(r.success,true);};
const pages=[['', '/', 'Everything you need. One marketplace.'],['seller.','/merchant/register','Become a merchant'],['partners.','/provider/signup',''],['festus.','/admin','Main Admin sign in'],['staff.','/admin','']];
for(const width of [1280,390]){
 browser('set','viewport',String(width),'844');
 for(const [prefix,path,title] of pages){
  navigate(`https://${prefix}${domain}${path}`);
  const state=evaluate('({heading:document.querySelector("h1")?.textContent,overflow:document.documentElement.scrollWidth>innerWidth,text:document.body.innerText})');
  if(title) assert.equal(state.heading?.replace(/\s/g,""),title.replace(/\s/g,""));
  assert.equal(state.overflow,false,`${prefix}${path} at ${width}px`);
  assert.ok(!state.text.includes('We could not load this page'),`${prefix}${path}`);
  console.log(`Rendered ${prefix}${domain}${path} at ${width}px without page overflow`);
 }
}
navigate(`https://festus.${domain}/admin`);
browser('find','role','button','click','--name','Face + PIN');
browser('wait','--fn','document.body.innerText.includes("facial sign-in is not yet activated")');
assert.match(evaluate('document.body.innerText'),/facial sign-in is not yet activated/);
assert.equal(evaluate('document.querySelectorAll("video").length'),0);
navigate(`https://${domain}/checkout`);
assert.match(evaluate('document.body.innerText'),/beta/i);
assert.equal(evaluate('document.querySelectorAll("input[name=cardNumber]").length'),0);
navigate(`https://${domain}/`);
assert.match(evaluate('document.body.innerText'),/Developer Beta/);
assert.equal(evaluate('[...document.querySelectorAll("button")].filter(b=>b.getAttribute("aria-label")==="Enable push notifications").length'),0);
console.log('Executive face login unavailable; beta checkout restrictions and disabled push verified');
