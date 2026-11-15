// Admin permission system: policy rules, catalogue consistency, and a source
// guard proving every admin server function checks a permission on the server.
// Regression: none of this was covered, and the authorization script in
// package.json pointed at a test file that did not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADMIN_CAPABILITIES, ADMIN_CAPABILITY_LABELS, canGrantedAdminPerform, canDelegatedAdminManageRoles,
  expandAdminCapabilities, canAdminPerform,
} from '../src/modules/identity/public/auth/admin-permission-policy.mjs';
import { loadTypeScript } from '../scripts/helpers/load-typescript.mjs';

const { adminDefaultRoute } = loadTypeScript('src/modules/administration/internal/admin-default-route.ts');

test('Main Administrator holds every permission, including full control', () => {
  for (const capability of ['admin.full', ...ADMIN_CAPABILITIES]) {
    assert.equal(canGrantedAdminPerform('owner', [], capability), true, capability);
  }
});

test('unknown permissions fail closed, even for the Main Administrator', () => {
  assert.equal(canGrantedAdminPerform('owner', [], 'admin.everything'), false);
  assert.equal(canGrantedAdminPerform('ops', ['admin.everything'], 'admin.everything'), false);
  assert.deepEqual(expandAdminCapabilities(['admin.everything', 'admin.finance.view']), ['admin.finance.view']);
});

test('a sub-admin can never hold full control, even if it is stored against their role', () => {
  assert.equal(canGrantedAdminPerform('support', ['admin.full'], 'admin.full'), false);
  assert.equal(canGrantedAdminPerform('support', ['admin.full'], 'admin.support'), false);
});

test('a sub-admin gets exactly the permissions of their roles and nothing else', () => {
  const grants = ['admin.support', 'admin.finance.refunds'];
  const effective = new Set([...grants, 'admin.support.view']); // replying to support implies reading it
  for (const capability of ADMIN_CAPABILITIES) {
    assert.equal(canGrantedAdminPerform('custom', grants, capability), effective.has(capability), capability);
  }
  assert.equal(canGrantedAdminPerform('custom', [], 'admin.support'), false, 'no default permission');
});

test('bundle permissions expand to their parts only', () => {
  assert.deepEqual(new Set(expandAdminCapabilities(['admin.operations'])), new Set([
    'admin.operations', 'admin.merchants.review', 'admin.merchants.moderate',
    'admin.customers.moderate', 'admin.products.moderate', 'admin.categories.manage',
    'admin.reviews.moderate', 'admin.catalog.view',
  ]));
  assert.ok(expandAdminCapabilities(['admin.staff.manage']).includes('admin.staff.directory'));
  assert.deepEqual(new Set(expandAdminCapabilities(['admin.orders.manage'])), new Set(['admin.orders.manage', 'admin.orders.view']));
  assert.deepEqual(new Set(expandAdminCapabilities(['admin.support'])), new Set(['admin.support', 'admin.support.view']));
});

test('separation of duties: setting commission does not allow settling payouts', () => {
  const policy = expandAdminCapabilities(['admin.finance.policy']);
  assert.ok(policy.includes('admin.finance.view'));
  assert.ok(!policy.includes('admin.finance.payouts'));
  assert.ok(!expandAdminCapabilities(['admin.finance.view']).includes('admin.finance.payouts'));
  assert.ok(!expandAdminCapabilities(['admin.finance.payouts']).includes('admin.finance.policy'));
  for (const readOnly of ['admin.overview.view', 'admin.orders.view', 'admin.support.view', 'admin.catalog.view', 'admin.reports.view', 'admin.finance.view']) {
    assert.deepEqual(expandAdminCapabilities([readOnly]), [readOnly], `${readOnly} grants nothing else`);
  }
  assert.ok(!expandAdminCapabilities(['admin.orders.manage']).includes('admin.finance.refunds'), 'order managers cannot refund on their own');
});

test('legacy fixed roles keep their original baseline', () => {
  assert.equal(canAdminPerform('operations', 'admin.products.moderate'), true);
  assert.equal(canAdminPerform('operations', 'admin.finance.refunds'), false);
  assert.equal(canAdminPerform('support', 'admin.support'), true);
  assert.equal(canAdminPerform('support', 'admin.staff.manage'), false);
});

test('HR managers can only hand out permissions they hold, and never Main Admin', () => {
  const base = { actorOwner: false, oldPrimaryRole: 'support', nextPrimaryRole: 'support', oldCapabilities: [], nextCapabilities: [] };
  const hr = ['admin.staff.manage', 'admin.support'];
  assert.equal(canDelegatedAdminManageRoles({ ...base, actorCapabilities: hr, oldCapabilities: ['admin.support'] }), true);
  assert.equal(canDelegatedAdminManageRoles({ ...base, actorCapabilities: hr, oldCapabilities: ['admin.finance.refunds'] }), false, 'outside own authority');
  assert.equal(canDelegatedAdminManageRoles({ ...base, actorCapabilities: ['admin.support'] }), false, 'needs staff.manage');
  assert.equal(canDelegatedAdminManageRoles({ ...base, actorCapabilities: hr, nextPrimaryRole: 'owner' }), false, 'cannot create a Main Admin');
  assert.equal(canDelegatedAdminManageRoles({ ...base, actorCapabilities: hr, oldPrimaryRole: 'owner' }), false, 'cannot touch a Main Admin');
  assert.equal(canDelegatedAdminManageRoles({ ...base, actorOwner: true, actorCapabilities: [], nextPrimaryRole: 'owner' }), true);
});

test('money-approval powers can only be granted by the Main Administrator (security audit H1)', () => {
  const base = { actorOwner: false, oldPrimaryRole: 'support', nextPrimaryRole: 'support', nextCapabilities: [] };
  const hrWithFinance = ['admin.staff.manage', 'admin.finance.refunds', 'admin.finance.payouts', 'admin.support'];
  for (const power of ['admin.finance.refunds', 'admin.finance.payouts', 'admin.staff.manage']) {
    assert.equal(canDelegatedAdminManageRoles({ ...base, actorCapabilities: hrWithFinance, oldCapabilities: [power] }), false, power);
    assert.equal(canDelegatedAdminManageRoles({ ...base, actorOwner: true, actorCapabilities: [], oldCapabilities: [power] }), true, `owner may grant ${power}`);
  }
  assert.equal(canDelegatedAdminManageRoles({ ...base, actorCapabilities: hrWithFinance, oldCapabilities: ['admin.support'] }), true, 'ordinary grants still delegable');
});

test('permission catalogue matches the database allow-list, the TypeScript type and the labels', () => {
  const dir = 'migrations';
  const latest = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .filter((sql) => /admin_role_permissions_capability_check\s+check|capability text NOT NULL CHECK/i.test(sql)).at(-1);
  const block = latest.slice(latest.search(/capability in \(|capability IN \(/i));
  const dbList = new Set([...block.slice(0, block.indexOf('))')).matchAll(/'(admin\.[a-z.]+)'/g)].map((m) => m[1]));
  assert.deepEqual(dbList, new Set(['admin.full', ...ADMIN_CAPABILITIES]), 'migration CHECK list');
  const tsSource = fs.readFileSync('src/modules/identity/internal/auth/authorization.server.ts', 'utf8');
  const union = tsSource.slice(tsSource.indexOf('export type AdminCapability'), tsSource.indexOf(';', tsSource.indexOf('export type AdminCapability')));
  assert.deepEqual(new Set([...union.matchAll(/"(admin\.[a-z.]+)"/g)].map((m) => m[1])), dbList, 'AdminCapability type');
  assert.deepEqual(new Set(Object.keys(ADMIN_CAPABILITY_LABELS)), new Set(ADMIN_CAPABILITIES), 'every permission has a label');
});

test('every sub-admin permission has somewhere to land after sign-in', () => {
  for (const capability of ADMIN_CAPABILITIES) {
    const route = adminDefaultRoute({ staffRole: 'custom', capabilities: expandAdminCapabilities([capability]) });
    assert.notEqual(route, '/admin/security', `${capability} lands on an empty console`);
  }
  assert.equal(adminDefaultRoute({ staffRole: 'owner', capabilities: [] }), '/admin/dashboard');
  assert.equal(adminDefaultRoute({ staffRole: 'custom', capabilities: [] }), '/admin/security');
});

// ---- Source guard -------------------------------------------------------------

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const PERMISSION_CHECK = /\b(requireAdminForUserId|getAdminCapabilitiesForUserId|adminGuard|requireFinanceAdmin|requireMerchantAccessForUserId)\s*\(/;
/** Admin server functions that intentionally run without an admin permission. */
const PUBLIC_ADMIN_ENTRY_POINTS = new Set([
  'getAdminAccessState', // the /admin sign-in page; returns only the caller's own state
]);
/** Admin server functions that deliberately stay Main-Administrator-only. Add here only on purpose. */
const OWNER_ONLY = new Set([
  'loadAdminDashboard', 'viewMerchantSensitiveData', 'saveAdminRole',
]);

function adminServerFunctions() {
  const out = [];
  for (const file of walk('src').filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(`${path.sep}public${path.sep}`))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/export const (\w+)\s*=\s*createServerFn/g)) {
      const start = m.index + m[0].length;
      const next = source.slice(start).search(/\nexport (const|async function|function) /);
      const body = source.slice(start, next === -1 ? undefined : start + next);
      const isAdmin = /[\\/]admin[\\/]|admin-/i.test(file) || /Admin/.test(m[1]) || /requireAdmin|getAdminCapabilities/.test(body);
      if (isAdmin) out.push({ file, name: m[1], body });
    }
  }
  return out;
}

test('every admin server function checks a permission on the server', () => {
  const fns = adminServerFunctions();
  assert.ok(fns.length >= 50, `found only ${fns.length} admin server functions; scanner broken?`);
  const unchecked = fns.filter((f) => !PUBLIC_ADMIN_ENTRY_POINTS.has(f.name) && !PERMISSION_CHECK.test(f.body)
    && !/assertPortalOperationHost\(\s*["']provider["']\s*\)/.test(f.body));
  assert.deepEqual(unchecked.map((f) => `${f.file}:${f.name}`), []);
});

/** Number of top-level arguments in each requireAdminForUserId(...) call (bracket-aware). */
function adminCallArgCounts(body) {
  const counts = [];
  for (const m of body.matchAll(/requireAdminForUserId\(/g)) {
    let depth = 1, args = 1, i = m.index + m[0].length;
    for (; i < body.length && depth > 0; i++) {
      const c = body[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 1) args++;
    }
    counts.push(args);
  }
  return counts;
}

test('owner-only admin functions are an explicit, reviewed list', () => {
  // requireAdminForUserId(user) with no permission argument means Main Administrator only.
  const ownerOnly = adminServerFunctions().filter((f) => adminCallArgCounts(f.body).some((n) => n === 1)).map((f) => f.name);
  assert.deepEqual(new Set(ownerOnly), OWNER_ONLY);
});

test('jobs that used to need the Main Administrator are delegated to the right permission', () => {
  const expectations = [
    ['src/modules/catalog/internal/homepage.functions.ts', /requireAdminForUserId\(adminId,'admin\.campaigns\.manage'\)/],
    ['src/modules/logistics/internal/dispatch.server.ts', /requireAdminForUserId\(userId, "admin\.providers\.manage"\)/],
    ['src/modules/merchants/internal/merchant-health.ts', /requireAdminForUserId\(userId, "admin\.merchants\.moderate"\)/],
  ];
  for (const [file, pattern] of expectations) assert.match(fs.readFileSync(file, 'utf8'), pattern, file);
});

test('manual payout settlement cannot bypass two-person approval', () => {
  const wallet = fs.readFileSync('src/modules/wallet/internal/transport/merchant/wallet.functions.ts', 'utf8');
  assert.doesNotMatch(wallet, /resolvePayoutByAdmin/, 'wallet transport must not settle payouts directly');
  const callers = walk('src').filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => /resolvePayoutByAdmin\s*\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => f.split(path.sep).join('/'));
  assert.deepEqual(new Set(callers), new Set([
    'src/modules/wallet/internal/wallet.server.ts',
    'src/modules/administration/internal/transport/admin/finance-approvals.functions.ts',
  ]));
});

// ---- Two-person threshold -----------------------------------------------------

test('two-person threshold: default, boundary, override and fail-closed', () => {
  const { requiresDualApproval, dualApprovalThreshold } = loadTypeScript(
    'src/modules/administration/internal/dual-approval.server.ts', { '@/lib/db': {} });
  const saved = process.env.ELEMARKET_DUAL_APPROVAL_THRESHOLD_GHS;
  try {
    delete process.env.ELEMARKET_DUAL_APPROVAL_THRESHOLD_GHS;
    assert.equal(dualApprovalThreshold(), 1000);
    assert.equal(requiresDualApproval('1000.00'), false, 'at the limit: one person');
    assert.equal(requiresDualApproval('1000.01'), true, 'above the limit: two people');
    assert.equal(requiresDualApproval('NaN'), true, 'unreadable amount fails closed');
    process.env.ELEMARKET_DUAL_APPROVAL_THRESHOLD_GHS = '0';
    assert.equal(requiresDualApproval('0.01'), true, '0 = always two people');
    process.env.ELEMARKET_DUAL_APPROVAL_THRESHOLD_GHS = '-5';
    assert.throws(() => requiresDualApproval('1'), /non-negative/);
  } finally {
    if (saved === undefined) delete process.env.ELEMARKET_DUAL_APPROVAL_THRESHOLD_GHS;
    else process.env.ELEMARKET_DUAL_APPROVAL_THRESHOLD_GHS = saved;
  }
});

// Duplicate-removal guard: one implementation of money/date formatting and
// email masking. Pages must not grow private copies again.
test('money/date formatting and email masking have a single implementation', () => {
  const offenders = walk('src').filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(`shared${path.sep}internal${path.sep}display.ts`))
    .filter((f) => /const ghs = \(|const when = \(v|function maskEmail\w*\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
