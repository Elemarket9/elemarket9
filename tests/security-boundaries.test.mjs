import test from 'node:test';
import assert from 'node:assert/strict';
import { portalAllowsAuthRequest, portalAllowsPath, getPortalConfiguration, isPermittedAdminPrincipal } from '../src/lib/security/portal-policy.mjs';
import { isDeveloperBeta, assertCommerceExecutionAllowed } from '../src/lib/security/launch-profile.mjs';
import { faceEngineConfigured, verifyLiveFace } from '../src/modules/identity/internal/auth/executive/engine.server.mjs';
import { hashExecutivePassphrase, verifyExecutivePassphrase, validateExecutivePassphrase, requireSameOrigin } from '../src/modules/identity/internal/auth/executive/security.mjs';
import { canGrantedAdminPerform, canDelegatedAdminManageRoles } from '../src/modules/identity/internal/auth/admin-permission-policy.mjs';
const env = {
 ELEMARKET_PORTAL_HOST_ROUTING: '1', ELEMARKET_EXECUTIVE_USER_ID: 'owner-id',
 ELEMARKET_DOMAIN: 'market.example.test', ELEMARKET_EXECUTIVE_HOST: 'chief.example.test',
 ELEMARKET_STAFF_HOST: 'employees.example.test', ELEMARKET_SELLER_HOST: 'vendors.example.test',
 ELEMARKET_PROVIDER_HOST: 'services.example.test',
};

test('portal routing rejects unknown hosts and isolates private pages including encoded paths', () => {
 const { hosts } = getPortalConfiguration(env);
 for (const host of [null, 'attacker.test', 'chief.example.test.attacker.test', 'chief.example.test,attacker.test']) {
  assert.equal(portalAllowsPath(host, '/', env), false);
 }
 for (const [portal, host] of Object.entries(hosts)) {
  for (const path of ['/admin', '/admin/team', '/%61dmin/team', '//admin/team'])
   assert.equal(portalAllowsPath(host, path, env), ['executive','staff'].includes(portal), `${host}${path}`);
  assert.equal(portalAllowsPath(host, '/merchant/dashboard', env), portal === 'seller');
  assert.equal(portalAllowsPath(host, '/provider/financing', env), portal === 'provider');
  assert.equal(portalAllowsPath(host, '/partner/financing', env), portal === 'provider');
  assert.equal(portalAllowsPath(host, '/api/auth/executive/face-sign-in', env), portal === 'executive');
  assert.equal(portalAllowsPath(host, '/api/executive/face', env), portal === 'executive');
 }
 assert.throws(() => getPortalConfiguration({...env, ELEMARKET_STAFF_HOST: env.ELEMARKET_EXECUTIVE_HOST}), /distinct/);
});

test('owner identity and employee host are independently enforced', () => {
 for (const [staffRole,userId,requestHost,allowed] of [
  ['owner','owner-id',env.ELEMARKET_EXECUTIVE_HOST,true],
  ['owner','another-owner',env.ELEMARKET_EXECUTIVE_HOST,false],
  ['owner','owner-id',env.ELEMARKET_STAFF_HOST,false],
  ['support','employee',env.ELEMARKET_STAFF_HOST,true],
  ['support','employee',env.ELEMARKET_EXECUTIVE_HOST,false],
  ['support','employee',env.ELEMARKET_DOMAIN,false],
 ]) assert.equal(isPermittedAdminPrincipal({staffRole,userId,requestHost,env}),allowed);
});

test('custom admin grants cannot create an implicit superuser or delegate absent permissions', () => {
 assert.equal(canGrantedAdminPerform('custom',['admin.full'],'admin.full'),false);
 assert.equal(canGrantedAdminPerform('custom',['admin.operations'],'admin.products.moderate'),true);
 assert.equal(canGrantedAdminPerform('custom',['admin.support'],'admin.finance.refunds'),false);
 assert.equal(canDelegatedAdminManageRoles({actorOwner:false,actorCapabilities:['admin.staff.manage'],oldCapabilities:[],nextCapabilities:['admin.finance.refunds'],oldPrimaryRole:'support',nextPrimaryRole:'custom'}),false);
});

test('shared beta forbids commerce even if preview settlement is requested', () => {
 for (const ELEMARKET_ENV of ['staging','production']) {
  const config={ELEMARKET_ENV,ELEMARKET_LAUNCH_PROFILE:'developer_beta',ELEMARKET_ENABLE_PREVIEW_SETTLEMENT:'1'};
  assert.equal(isDeveloperBeta(config),true);
  for (const action of ['checkout','payment','refund','financing','delivery']) assert.throws(()=>assertCommerceExecutionAllowed(action,config),/disabled/);
 }
});

test('face authentication stays unavailable in shared environments despite configured engine', async () => {
 const keys=['ELEMARKET_ENV','ELEMARKET_EXEC_FACE_ENABLED','EIDE_EXEC_FACE_ENGINE_URL','EIDE_EXEC_FACE_ENGINE_SECRET','EIDE_EXEC_FACE_ENGINE_POLICY_ID'];
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try {
  Object.assign(process.env,{ELEMARKET_EXEC_FACE_ENABLED:'1',EIDE_EXEC_FACE_ENGINE_URL:'https://verifier.example.test/v1/verify',EIDE_EXEC_FACE_ENGINE_SECRET:'synthetic-key'.repeat(4),EIDE_EXEC_FACE_ENGINE_POLICY_ID:'independent-policy'});
  for (const mode of ['staging','production','preview']) {
   process.env.ELEMARKET_ENV=mode;
   assert.equal(faceEngineConfigured(),false);
   await assert.rejects(verifyLiveFace({operation:'login',challengeId:'x',nonce:'x',prompt:'blink',frames:[]}),/unavailable/);
  }
 } finally { for(const key of keys) { if(saved[key]===undefined) delete process.env[key]; else process.env[key]=saved[key]; } }
});

test('executive passphrase hashes are salted and malformed credentials fail closed', async () => {
 const pin='SyntheticPassphrase123';
 const first=await hashExecutivePassphrase(pin); const second=await hashExecutivePassphrase(pin);
 assert.notEqual(first,second);
 assert.equal(await verifyExecutivePassphrase(pin,first),true);
 assert.equal(await verifyExecutivePassphrase('WrongPassphrase123',first),false);
 assert.equal(await verifyExecutivePassphrase(pin,'scrypt-v1$broken$hash'),false);
 assert.equal(validateExecutivePassphrase('too-short'),false);
 assert.equal(validateExecutivePassphrase('ControlCharacter\n123'),false);
 assert.throws(()=>requireSameOrigin(new Request('https://chief.example.test/api',{headers:{host:'chief.example.test',origin:'https://market.example.test','content-type':'application/json'}}),'chief.example.test'),/Cross-origin/);
});


test('auth API requires the receiving portal origin and rejects sibling fetches',()=>{
 const host=env.ELEMARKET_EXECUTIVE_HOST;
 const request=(headers={},method='POST')=>new Request(`https://${host}/api/auth/sign-out`,{method,headers:{host,...headers}});
 assert.equal(portalAllowsAuthRequest(request({origin:`https://${host}`}),env),true);
 assert.equal(portalAllowsAuthRequest(request(),env),true,'Native clients remain subject to Better Auth authentication');
 for(const origin of [`https://${env.ELEMARKET_DOMAIN}`,`https://${env.ELEMARKET_STAFF_HOST}`,'null',`http://${host}`,`https://${host}.attacker.test`])
  assert.equal(portalAllowsAuthRequest(request({origin}),env),false);
 assert.equal(portalAllowsAuthRequest(request({'sec-fetch-site':'same-site'}),env),false);
 assert.equal(portalAllowsAuthRequest(request({'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'},'GET'),env),true,'Top-level authentication callbacks may navigate');
 assert.equal(portalAllowsAuthRequest(request({'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'object'},'GET'),env),false);
});
