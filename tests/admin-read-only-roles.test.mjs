// Read-only admin roles: `admin.support.view` (support inbox) and
// `admin.catalog.view` (marketplace operations queues). Proves that
//  (a) every support / operations mutation still asks for its exact write permission,
//  (b) read endpoints accept the view permission and reject a viewer with neither,
//  (c) a view-only principal never expands into a write capability.
// The real server-function modules are executed with only their external
// boundaries (auth, DB, rate limit) stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadTypeScript, serverFunctionStub } from '../scripts/helpers/load-typescript.mjs';
import {
  ADMIN_CAPABILITIES, canGrantedAdminPerform, expandAdminCapabilities,
} from '../src/modules/identity/public/auth/admin-permission-policy.mjs';

const DENIED = 'stub: permission denied';

/** Build stubs for one call. `caps` is what getAdminCapabilitiesForUserId returns (already expanded). */
function harness(caps = []) {
  const calls = { required: [], capsRead: 0, sql: [], fresh: 0, rateLimited: [] };
  const sql = {
    async query(text, params) {
      calls.sql.push(text);
      if (/from support_conversations c join "user" u on u.id=c.customer_id left join "user" au on au.id=c.assigned_admin_id where c.id=\$1/.test(text)) {
        return [{ id: params[0], status: 'open' }];
      }
      return [];
    },
  };
  const deps = {
    '@tanstack/react-start': { createServerFn: () => serverFunctionStub() },
    '@/modules/identity/public/auth/middleware': { authMiddleware: {}, getAuthenticatedUserId: () => 'admin-1' },
    '@/modules/identity/public/auth/authorization.server': {
      async requireAdminForUserId(_user, capability) { calls.required.push(capability ?? '(owner-only)'); throw new Error(DENIED); },
      async getAdminCapabilitiesForUserId() { calls.capsRead += 1; return caps; },
    },
    '@/modules/identity/public/auth/verify.server': { async requireFreshSession() { calls.fresh += 1; return 'admin-1'; } },
    '@/lib/db': { async getSql() { return sql; }, async withTransaction(fn) { return fn(sql); } },
    '@/lib/security/rate-limit.server': { async enforceRateLimit(bucket) { calls.rateLimited.push(bucket); } },
    '@/modules/merchants/public/kyb/index.server': { async runMerchantKyb() { throw new Error('not in test'); } },
    '@/modules/logistics/public/adapters/location.server': { async geocodeAddressServer() { throw new Error('not in test'); } },
  };
  return { calls, deps };
}

const SUPPORT = 'src/modules/support/internal/admin-support.functions.ts';
const MODERATION = 'src/modules/administration/internal/transport/admin/moderation.functions.ts';
const DASHBOARD = 'src/modules/administration/internal/transport/admin/dashboard.functions.ts';
const MERCHANT_REVIEW = 'src/modules/merchants/internal/transport/admin/merchant-review.functions.ts';

const conv = 'conv-1';
const key = 'k'.repeat(24);
/** Every write reachable from /admin/support and /admin/operations, with valid input. */
const WRITES = [
  [SUPPORT, 'replySupportThread', { conversationId: conv, body: 'hello', idempotencyKey: key }, 'admin.support'],
  [SUPPORT, 'addSupportInternalNote', { conversationId: conv, body: 'note', idempotencyKey: key }, 'admin.support'],
  [SUPPORT, 'updateSupportConversationState', { conversationId: conv, action: 'claim' }, 'admin.support'],
  [SUPPORT, 'createAssistedOrderDraft', { conversationId: conv, items: [{ productId: 'p1', quantity: 1 }] }, 'admin.support'],
  [SUPPORT, 'manageOrderDeliveryHold', { orderId: 'o1', action: 'hold', reason: 'customer reported fraud' }, 'admin.support'],
  [SUPPORT, 'manageOrderDeliveryHold', { orderId: 'o1', action: 'release', reason: 'caller identity verified' }, 'admin.support'],
  [MODERATION, 'moderateMerchant', { merchantId: 'm1', action: 'suspend', reason: 'documented evidence' }, 'admin.merchants.moderate'],
  [MODERATION, 'moderateCustomer', { userId: 'u1', action: 'blacklist', reason: 'documented evidence' }, 'admin.customers.moderate'],
  [MODERATION, 'moderateProduct', { productId: 'p1', action: 'approve', reason: 'documented evidence' }, 'admin.products.moderate'],
  [DASHBOARD, 'setCatalogTaxonomyState', { scope: 'category', categoryKey: 'phones', subcategoryKey: null, active: false, reason: 'seasonal' }, 'admin.categories.manage'],
  [MERCHANT_REVIEW, 'reviewMerchantApplication', { applicationId: 'a1', action: 'start_review' }, 'admin.merchants.review'],
];

for (const [file, name, data, capability] of WRITES) {
  test(`${name}${data.action ? ` (${data.action})` : ''} still requires ${capability}, even for a full viewer`, async () => {
    // The viewer holds every read-only permission; the write check must not consult them.
    const { calls, deps } = harness(['admin.support.view', 'admin.catalog.view', 'admin.orders.view']);
    const fn = loadTypeScript(file, deps)[name];
    assert.equal(typeof fn, 'function', `${name} exported`);
    await assert.rejects(fn({ data, context: {} }), new RegExp(DENIED));
    assert.equal(calls.required[0], capability, 'first permission check is the exact write permission');
    assert.equal(calls.capsRead, 0, 'writes never fall back to the multi-permission read check');
    assert.equal(calls.sql.length, 0, 'no database work before authorization');
    assert.equal(calls.fresh, 0, 'permission is checked before anything else');
  });
}

test('the write list covers every server function in the support and moderation modules', () => {
  const reads = new Set(['listSupportInbox', 'getSupportThread', 'searchProductsForAssistedOrder',
    'loadAdminModeration', 'loadAdminOperationsQueues', 'loadEnterpriseMerchantCandidates', 'setMerchantEnterpriseMode']);
  const covered = new Set(WRITES.map(([, name]) => name));
  for (const file of [SUPPORT, MODERATION]) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/export const (\w+)\s*=\s*createServerFn/g)) {
      assert.ok(reads.has(m[1]) || covered.has(m[1]), `${file}:${m[1]} has no permission test`);
    }
  }
});

test('searchProductsForAssistedOrder stays agent-only (it only feeds the assisted-order composer)', async () => {
  const { calls, deps } = harness(['admin.support.view']);
  const { searchProductsForAssistedOrder } = loadTypeScript(SUPPORT, deps);
  await assert.rejects(searchProductsForAssistedOrder({ data: { q: 'phone' }, context: {} }), new RegExp(DENIED));
  assert.deepEqual(calls.required, ['admin.support']);
});

// ---- Support reads ------------------------------------------------------------

const SUPPORT_READERS = [
  ['support agent', expandAdminCapabilities(['admin.support'])],
  ['support viewer', expandAdminCapabilities(['admin.support.view'])],
  ['Main Administrator', ['admin.full']],
];
for (const [who, caps] of SUPPORT_READERS) {
  test(`support inbox and threads open for a ${who}`, async () => {
    const { calls, deps } = harness(caps);
    const { listSupportInbox, getSupportThread } = loadTypeScript(SUPPORT, deps);
    assert.deepEqual(await listSupportInbox({ context: {} }), []);
    const thread = await getSupportThread({ data: { conversationId: conv }, context: {} });
    assert.equal(thread.conversation.id, conv);
    assert.deepEqual(calls.required, [], 'reads use the multi-permission check, not requireAdminForUserId');
    assert.equal(calls.capsRead, 2);
  });
}

test('support reads reject an admin with neither support permission, before touching the database', async () => {
  for (const caps of [[], expandAdminCapabilities(['admin.catalog.view', 'admin.orders.view', 'admin.operations'])]) {
    const { calls, deps } = harness(caps);
    const { listSupportInbox, getSupportThread } = loadTypeScript(SUPPORT, deps);
    await assert.rejects(listSupportInbox({ context: {} }), /Forbidden/);
    await assert.rejects(getSupportThread({ data: { conversationId: conv }, context: {} }), /Forbidden/);
    assert.equal(calls.sql.length, 0);
  }
});

test('opening a thread is read-only: no insert/update/delete and no state-changing SQL function', async () => {
  const { calls, deps } = harness(['admin.support.view']);
  const { listSupportInbox, getSupportThread } = loadTypeScript(SUPPORT, deps);
  await listSupportInbox({ context: {} });
  await getSupportThread({ data: { conversationId: conv }, context: {} });
  assert.ok(calls.sql.length >= 4);
  for (const text of calls.sql) {
    assert.doesNotMatch(text, /\b(insert|update|delete|for update)\b/i, text);
    assert.doesNotMatch(text, /set_config|append_support|add_support|update_support|create_assisted/i, text);
  }
});

// ---- Operations reads ---------------------------------------------------------

test('catalog viewers receive every operations section; section holders receive only theirs', async () => {
  const cases = [
    [expandAdminCapabilities(['admin.catalog.view']), 3, 3],
    [['admin.full'], 3, 3],
    [expandAdminCapabilities(['admin.operations']), 3, 3],
    [['admin.products.moderate'], 1, null],
    [['admin.merchants.moderate', 'admin.customers.moderate'], 2, null],
    [['admin.merchants.review'], null, 1],
    [['admin.categories.manage'], null, 2],
  ];
  for (const [caps, moderationQueries, queueQueries] of cases) {
    for (const [name, expected] of [['loadAdminModeration', moderationQueries], ['loadAdminOperationsQueues', queueQueries]]) {
      const { calls, deps } = harness(caps);
      const fn = loadTypeScript(MODERATION, deps)[name];
      if (expected === null) {
        await assert.rejects(fn({ context: {} }), /Forbidden/, `${name} for ${caps}`);
        assert.equal(calls.sql.length, 0);
      } else {
        await fn({ context: {} });
        assert.equal(calls.sql.length, expected, `${name} for ${caps}`);
      }
      assert.deepEqual(calls.required, []);
    }
  }
});

test('operations loads reject an admin with no operations permission and no catalog.view', async () => {
  for (const caps of [[], expandAdminCapabilities(['admin.support', 'admin.orders.manage', 'admin.finance.policy'])]) {
    for (const name of ['loadAdminModeration', 'loadAdminOperationsQueues']) {
      const { calls, deps } = harness(caps);
      await assert.rejects(loadTypeScript(MODERATION, deps)[name]({ context: {} }), /Forbidden/);
      assert.equal(calls.sql.length, 0);
    }
  }
});

// ---- Policy -------------------------------------------------------------------

const WRITE_CAPABILITIES = ADMIN_CAPABILITIES.filter((c) => !/\.view$|^admin\.audit\.read$|^admin\.staff\.directory$/.test(c));

test('a view-only principal gains no write capability through expansion', () => {
  assert.ok(WRITE_CAPABILITIES.includes('admin.support') && WRITE_CAPABILITIES.includes('admin.products.moderate'));
  const viewer = ['admin.support.view', 'admin.catalog.view'];
  assert.deepEqual(new Set(expandAdminCapabilities(viewer)), new Set(viewer));
  for (const capability of [...WRITE_CAPABILITIES, 'admin.full']) {
    assert.equal(canGrantedAdminPerform('qa-trainee', viewer, capability), false, capability);
  }
  for (const grant of viewer) assert.deepEqual(expandAdminCapabilities([grant]), [grant]);
});

// ---- UI wiring (navigation is not a security boundary, but must not mislead) --

test('support page gates on either permission and only enables writing for admin.support', () => {
  const route = fs.readFileSync('src/routes/admin/support.tsx', 'utf8');
  assert.match(route, /can\("admin\.support"\) \|\| can\("admin\.support\.view"\)/);
  assert.match(route, /canReply: can\("admin\.support"\)/);
  const ui = fs.readFileSync('src/components/admin-support-workspace.tsx', 'utf8');
  assert.match(ui, /canReply = false/, 'workspace is read-only unless told otherwise');
  assert.match(ui, /Read-only access\./);
  assert.match(ui, /const canManage = canReply &&/);
});

test('operations page shows actions only for their exact permission', () => {
  const ui = fs.readFileSync('src/routes/admin/operations.tsx', 'utf8');
  assert.match(ui, /Read-only access\./);
  for (const [action, capability] of [['moderateProduct', 'admin.products.moderate'], ['moderateMerchant', 'admin.merchants.moderate'],
    ['moderateCustomer', 'admin.customers.moderate'], ['applicationDecision\\(a\\.id', 'admin.merchants.review'],
    ['categoryDecision\\(c\\.key', 'admin.categories.manage']]) {
    const buttons = [...ui.matchAll(new RegExp(`onClick=\\{\\(\\)=>void (take\\([^,]+,reason=>)?${action}`, 'g'))];
    assert.ok(buttons.length > 0, `no ${action} button found; test out of date`);
    for (const m of buttons) {
      const before = ui.slice(0, m.index);
      const gate = before.lastIndexOf(`{can('${capability}')&&<>`);
      assert.ok(gate !== -1 && before.lastIndexOf('</>}') < gate, `${action} button is not wrapped in can('${capability}')`);
    }
  }
});
