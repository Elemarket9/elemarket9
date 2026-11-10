import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizedPortalHostname, getPortalConfiguration, portalFromRequestHost,
  portalAllowsPath, portalAllowsAuthRequest, isPermittedAdminPrincipal,
} from '../src/lib/security/portal-policy.mjs';

const env = {
  ELEMARKET_PORTAL_HOST_ROUTING: '1',
  ELEMARKET_DOMAIN: 'shop.example.com',
  ELEMARKET_EXECUTIVE_HOST: 'executive.example.com',
  ELEMARKET_STAFF_HOST: 'staff.example.com',
  ELEMARKET_SELLER_HOST: 'seller.example.com',
  ELEMARKET_PROVIDER_HOST: 'provider.example.com',
  ELEMARKET_EXECUTIVE_USER_ID: 'verified-owner-id',
};
test('all five private/public portal hosts are unique and resolved', () => {
  assert.equal(Object.keys(getPortalConfiguration(env).hosts).length, 5);
  assert.equal(portalFromRequestHost('shop.example.com', env), 'marketplace');
  assert.equal(portalFromRequestHost('seller.example.com:443', env), 'seller');
  assert.equal(portalFromRequestHost('evil.example.com', env), null);
});
test('invalid portal hostnames and duplicate portal hosts fail closed', () => {
  for (const host of ['127.0.0.1', 'http://shop.example.com', '*.example.com', 'shop.example.com:443', 'a..example.com']) {
    assert.equal(normalizedPortalHostname(host), null, host);
  }
  assert.throws(() => getPortalConfiguration({...env, ELEMARKET_SELLER_HOST: env.ELEMARKET_DOMAIN}), /distinct/);
});
test('marketplace cannot expose private dashboards', () => {
  for (const path of ['/admin', '/admin/dashboard', '/merchant', '/provider', '/partner/delivery', '/api/executive/login']) {
    assert.equal(portalAllowsPath(env.ELEMARKET_DOMAIN, path, env), false, path);
  }
  assert.equal(portalAllowsPath(env.ELEMARKET_DOMAIN, '/products', env), true);
});
test('cross-portal pages and malformed paths are denied', () => {
  assert.equal(portalAllowsPath(env.ELEMARKET_SELLER_HOST, '/admin', env), false);
  assert.equal(portalAllowsPath(env.ELEMARKET_PROVIDER_HOST, '/merchant', env), false);
  assert.equal(portalAllowsPath(env.ELEMARKET_DOMAIN, '/%61dmin', env), false);
  assert.equal(portalAllowsPath(env.ELEMARKET_DOMAIN, '/%2fadmin', env), false);
  assert.equal(portalAllowsPath('unknown.example.com', '/', env), false);
});
test('only verified owner identity can use executive host', () => {
  assert.equal(isPermittedAdminPrincipal({staffRole:'owner',userId:env.ELEMARKET_EXECUTIVE_USER_ID,requestHost:env.ELEMARKET_EXECUTIVE_HOST,env}),true);
  assert.equal(isPermittedAdminPrincipal({staffRole:'owner',userId:'other',requestHost:env.ELEMARKET_EXECUTIVE_HOST,env}),false);
  assert.equal(isPermittedAdminPrincipal({staffRole:'owner',userId:env.ELEMARKET_EXECUTIVE_USER_ID,requestHost:env.ELEMARKET_STAFF_HOST,env}),false);
});
test('browser auth calls cannot be initiated from sibling origins', () => {
  const req=(origin,site='same-origin',method='POST')=>new Request('https://executive.example.com/api/auth/sign-in/email',{method,headers:{host:env.ELEMARKET_EXECUTIVE_HOST,origin,'sec-fetch-site':site}});
  assert.equal(portalAllowsAuthRequest(req('https://executive.example.com'),env),true);
  assert.equal(portalAllowsAuthRequest(req('https://shop.example.com','same-site'),env),false);
  assert.equal(portalAllowsAuthRequest(req('https://attacker.example','cross-site'),env),false);
});
