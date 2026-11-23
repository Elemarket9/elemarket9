// Admin order workspace: search-input normalization, contact masking, timeline
// assembly and the source-level guarantees around the order actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadTypeScript } from '../scripts/helpers/load-typescript.mjs';

const orders = loadTypeScript('src/modules/administration/internal/admin-orders.ts');
const { normalizeAdminOrderSearch: normalize, maskEmail, maskPhone, buildOrderTimeline, orderActionAvailability, escapeLike } = orders;

test('an empty search is the recent-orders queue: last 7 days, default page size (audit M5)', () => {
  const before = Date.now();
  const n = normalize({});
  const { createdFrom, ...rest } = n;
  assert.deepEqual(rest, {
    orderId: null, orderSuffix: null, email: null, phone: null, merchantId: null, merchantNameLike: null,
    status: null, createdBefore: null, cursor: null, limit: 25,
  });
  const ageDays = (before - Date.parse(createdFrom)) / 86_400_000;
  assert.ok(ageDays > 6.99 && ageDays < 7.01, `createdFrom is ${ageDays} days ago`);
  assert.equal(normalize({ status: 'paid' }).createdFrom, null, 'any filter lifts the 7-day window');
});

test('delivery address is masked to its last two parts (audit M5)', () => {
  const { maskAddress } = loadTypeScript('src/modules/administration/internal/admin-orders.ts');
  assert.equal(maskAddress('House 12, Oxford Street, Osu, Accra'), '•••, Osu, Accra');
  assert.equal(maskAddress('Osu, Accra'), 'Address hidden · reveal to see it');
  assert.equal(maskAddress(null), null);
});

test('order ID: 8 characters search the suffix, longer is an exact ID, shorter is refused', () => {
  assert.equal(normalize({ orderId: ' #3f9a12bc ' }).orderSuffix, '3f9a12bc');
  assert.equal(normalize({ orderId: '3f9a12bc' }).orderId, null);
  const full = 'ord_0123456789abcdef0123456789abcdef';
  assert.equal(normalize({ orderId: full }).orderId, full);
  assert.equal(normalize({ orderId: full }).orderSuffix, null);
  assert.throws(() => normalize({ orderId: 'abc123' }), /last 8 characters/);
  assert.throws(() => normalize({ orderId: "ord_1' or 1=1--" }), /letters, numbers/);
  assert.equal(normalize({ orderId: '   ' }).orderId, null);
});

test('email is matched exactly, case-insensitively', () => {
  assert.equal(normalize({ email: '  Kofi.Mensah@Example.COM ' }).email, 'kofi.mensah@example.com');
  assert.throws(() => normalize({ email: 'kofi@' }), /full email/);
  assert.throws(() => normalize({ email: 'kofi mensah@example.com' }), /full email/);
});

test('phone numbers are normalized to the stored +233 form', () => {
  for (const raw of ['024 123 4567', '0241234567', '233241234567', '+233 24 123 4567', '(024) 123-4567']) {
    assert.equal(normalize({ phone: raw }).phone, '+233241234567', raw);
  }
  assert.throws(() => normalize({ phone: '12345' }), /Ghana mobile/);
  assert.throws(() => normalize({ phone: '0341234567' }), /Ghana mobile/);
});

test('merchant filter matches the ID exactly or the name with literal wildcards', () => {
  const n = normalize({ merchant: '50%_Off\\Shop' });
  assert.equal(n.merchantId, '50%_Off\\Shop');
  assert.equal(n.merchantNameLike, '%50\\%\\_Off\\\\Shop%');
  assert.equal(escapeLike('a_b'), 'a\\_b');
  assert.throws(() => normalize({ merchant: 'x' }), /2-120/);
});

test('status must be a real order status', () => {
  assert.equal(normalize({ status: 'payment_pending' }).status, 'payment_pending');
  assert.throws(() => normalize({ status: 'lost' }), /Unknown order status/);
});

test('date range covers whole days and rejects impossible ranges', () => {
  const n = normalize({ from: '2026-11-01', to: '2026-11-15' });
  assert.equal(n.createdFrom, '2026-11-01T00:00:00.000Z');
  assert.equal(n.createdBefore, '2026-11-16T00:00:00.000Z', 'to-date is inclusive');
  assert.throws(() => normalize({ from: '2026-11-15', to: '2026-11-01' }), /on or before/);
  assert.throws(() => normalize({ from: '2026-02-30' }), /real date/);
  assert.throws(() => normalize({ to: '15/11/2026' }), /YYYY-MM-DD/);
});

test('page size is capped at 50 and page links are validated', () => {
  assert.equal(normalize({ limit: 50 }).limit, 50);
  assert.throws(() => normalize({ limit: 51 }));
  assert.deepEqual(normalize({ cursor: '2026-11-15T10:00:00.123456Z|ord_abc' }).cursor, { at: '2026-11-15T10:00:00.123456Z', id: 'ord_abc' });
  assert.throws(() => normalize({ cursor: "2026-11-15|x' or 1=1" }), /page link/);
  assert.throws(() => normalize({ cursor: 'nonsense' }), /page link/);
});

test('contact details are masked so lists never expose full email or phone', () => {
  assert.equal(maskEmail('kofi.mensah@example.com'), 'k•••h@example.com');
  assert.equal(maskEmail('ab@example.com'), 'a•••@example.com');
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail('broken'), '•••');
  assert.equal(maskPhone('+233241234567'), '+233•••••4567');
  assert.equal(maskPhone(null), null);
  assert.equal(maskPhone('12345'), '•••');
  assert.ok(!maskPhone('+233241234567').includes('241234'));
  assert.ok(!maskEmail('kofi.mensah@example.com').includes('kofi'));
});

const emptySources = (extra = {}) => ({
  order: { createdAt: '2026-11-01T10:00:00Z', status: 'delivered' },
  statusHistory: [], payments: [], paymentTransitions: [], paymentAttempts: [], refunds: [], returns: [],
  deliveryJobs: [], handovers: [], holds: [], shipments: [], disputes: [], wallet: [], audit: [], notes: [], ...extra,
});

test('timeline merges every source in chronological order', () => {
  const t = buildOrderTimeline(emptySources({
    notes: [{ at: '2026-11-03T09:00:00Z', body: 'Customer called', actor: 'Ama' }],
    payments: [{ id: 'pay_1', at: new Date('2026-11-01T10:00:01Z'), method: 'mobile_money', status: 'completed', amount: '115.00' }],
    wallet: [{ at: '2026-11-02T12:00:00Z', entryType: 'sale', bucket: 'withheld', amount: '100.00' }],
    deliveryJobs: [{ providerName: 'Courier', status: 'delivered', failureReason: null, assignedAt: '2026-11-02T08:00:00Z', acceptedAt: null,
      pickedUpAt: null, inTransitAt: null, deliveredAt: '2026-11-02T11:00:00Z', failedAt: null, returnRequestedAt: null, returnedAt: null }],
    holds: [{ placedAt: '2026-11-01T12:00:00Z', reason: 'Fraud check', placedBy: 'Ama', releasedAt: '2026-11-01T13:00:00Z', releaseReason: 'Verified', releasedBy: 'Kwame', active: false }],
  }));
  assert.deepEqual(t.map((e) => e.title), [
    'Order placed', 'Payment created (mobile money, GH₵ 115.00)', 'Delivery hold placed', 'Delivery hold released',
    'Delivery assigned', 'Delivered (provider report)', 'Merchant wallet: sale (withheld)', 'Internal note',
  ]);
  assert.equal(t.at(-1).detail, 'Customer called');
  assert.ok(t.every((e, i) => i === 0 || t[i - 1].at <= e.at));
});

test('timeline skips missing timestamps and keeps an active hold open', () => {
  const t = buildOrderTimeline(emptySources({
    holds: [{ placedAt: '2026-11-01T12:00:00Z', reason: 'Stop', placedBy: null, releasedAt: null, releaseReason: null, releasedBy: null, active: true }],
    returns: [{ at: '2026-11-04T00:00:00Z', receivedAt: null, closedAt: null, status: 'requested', reasonCode: 'damaged', quantity: 1, resolutionType: null }],
  }));
  assert.deepEqual(t.map((e) => e.kind), ['order', 'hold', 'return']);
});

test('actions offered follow the safe paths only', () => {
  assert.deepEqual(orderActionAvailability({ status: 'payment_pending', paymentStatus: 'initiated', holdActive: false }),
    { cancelUnpaid: true, requestRefund: false, placeHold: false, releaseHold: false });
  assert.deepEqual(orderActionAvailability({ status: 'paid', paymentStatus: 'completed', holdActive: false }),
    { cancelUnpaid: false, requestRefund: true, placeHold: true, releaseHold: false });
  assert.deepEqual(orderActionAvailability({ status: 'shipped', paymentStatus: 'completed', holdActive: true }),
    { cancelUnpaid: false, requestRefund: true, placeHold: false, releaseHold: true });
  assert.equal(orderActionAvailability({ status: 'refunded', paymentStatus: 'completed', holdActive: false }).requestRefund, false);
});

test('order actions: permission, fresh session and rate limit on every mutation', () => {
  const src = fs.readFileSync('src/modules/administration/internal/transport/admin/orders.functions.ts', 'utf8');
  const fns = [...src.matchAll(/export const (\w+) = createServerFn\(\{ method: "(GET|POST)" \}\)([\s\S]*?)(?=\nexport const |\n*$)/g)];
  const byName = Object.fromEntries(fns.map((m) => [m[1], { method: m[2], body: m[3] }]));
  for (const name of ['addAdminOrderInternalNote', 'setAdminOrderDeliveryHold', 'cancelUnpaidAdminOrder', 'revealAdminOrderCustomerContact']) {
    const fn = byName[name];
    assert.ok(fn, name);
    assert.match(fn.body, /requireAdminForUserId\(actor, "admin\.orders\.manage"\)/, `${name} permission`);
    assert.match(fn.body, /assertFreshActor\(actor\)/, `${name} fresh session`);
    assert.match(fn.body, /enforceRateLimit\(/, `${name} rate limit`);
  }
  for (const name of ['searchAdminOrderList', 'loadAdminOrderDetail']) {
    assert.match(byName[name].body, /assertOrderReader\(/, `${name} read permission`);
    assert.match(byName[name].body, /enforceRateLimit\(/, `${name} rate limit`);
  }
  assert.equal(byName.searchAdminOrderList.method, 'POST', 'contact filters must not travel in URLs');
});

test('support and orders share one delivery-hold transaction', () => {
  const support = fs.readFileSync('src/modules/support/internal/admin-support.functions.ts', 'utf8');
  const orderServer = fs.readFileSync('src/modules/administration/internal/admin-orders.server.ts', 'utf8');
  assert.match(support, /requireAdminForUserId\(actor,"admin\.support"\)/);
  assert.match(support, /if\(data\.action==="release"\)[^\n]*requireFreshSession/);
  assert.match(support, /applyOrderDeliveryHold\(/);
  assert.doesNotMatch(support, /order_delivery_holds/, 'support must not keep its own copy of the hold SQL');
  assert.match(orderServer, /from "@\/modules\/support\/public\/delivery-hold\.server"/);
  assert.doesNotMatch(orderServer, /order_delivery_holds\(|update order_delivery_holds/);
});

test('search results never carry raw contact columns', () => {
  const src = fs.readFileSync('src/modules/administration/internal/admin-orders.server.ts', 'utf8');
  const listType = src.slice(src.indexOf('export type AdminOrderListRow'), src.indexOf('};', src.indexOf('export type AdminOrderListRow')));
  assert.doesNotMatch(listType, /customerEmail:|customerPhone:/);
  assert.match(listType, /customerEmailMasked/);
});
