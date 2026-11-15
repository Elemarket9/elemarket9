// Fraud & risk review queue: pure helpers (ordering, evidence formatting,
// masking) and source guards for the server functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadTypeScript } from '../scripts/helpers/load-typescript.mjs';

const fmt = loadTypeScript('src/modules/administration/internal/risk-review-format.ts');

test('severity ranks critical > high > medium > low, unknown last', () => {
  assert.deepEqual(['low', 'critical', 'medium', 'high', 'weird'].sort((a, b) => fmt.severityRank(a) - fmt.severityRank(b)),
    ['critical', 'high', 'medium', 'low', 'weird']);
});

test('queue order: open first, then severity, then oldest first, then id', () => {
  const f = (id, status, severity, createdAt) => ({ id, status, severity, createdAt });
  const flags = [
    f('a', 'resolved', 'critical', '2026-01-01T00:00:00Z'),
    f('b', 'open', 'medium', '2026-01-01T00:00:00Z'),
    f('c', 'open', 'critical', '2026-03-01T00:00:00Z'),
    f('d', 'open', 'critical', '2026-02-01T00:00:00Z'),
    f('e', 'open', 'high', '2026-01-01T00:00:00Z'),
    f('g', 'dismissed', 'low', '2025-01-01T00:00:00Z'),
    f('h', 'open', 'high', '2026-01-01T00:00:00Z'),
  ];
  assert.deepEqual([...flags].sort(fmt.compareRiskFlags).map((x) => x.id), ['d', 'c', 'e', 'h', 'b', 'a', 'g']);
});

test('decision maps to a consistent status', () => {
  assert.equal(fmt.statusForDecision('dismissed_false_positive'), 'dismissed');
  assert.equal(fmt.statusForDecision('confirmed_fraud'), 'resolved');
  assert.equal(fmt.statusForDecision('confirmed_monitor'), 'resolved');
  for (const d of fmt.RISK_DECISIONS) assert.ok(fmt.RISK_DECISION_LABELS[d], d);
  assert.equal(fmt.decisionLabel(null), null);
});

test('claim lasts 30 minutes', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  assert.equal(fmt.RISK_CLAIM_TTL_MINUTES, 30);
  assert.equal(fmt.isClaimActive('2026-11-15T11:31:00Z', now), true);
  assert.equal(fmt.isClaimActive('2026-11-15T11:30:00Z', now), false);
  assert.equal(fmt.isClaimActive(null, now), false);
  assert.equal(fmt.isClaimActive('not a date', now), false);
  // The database is the source of truth; keep the constant in step with it.
  assert.match(fs.readFileSync('migrations/0232_risk_review_queue.sql', 'utf8'), /risk_flag_claim_ttl\(\)[\s\S]*?interval '30 minutes'/);
});

test('emails are always masked', () => {
  assert.equal(fmt.maskEmail('ama.mensah@example.com'), 'a******h@e*****e.com');
  assert.equal(fmt.maskEmail('ab@x.io'), 'a*@x*.io');
  assert.equal(fmt.maskEmail('nodomain'), '***');
  assert.equal(fmt.maskEmail(null), null);
  const masked = fmt.maskEmail('kwame.nkrumah.longname@ghanapost.gov.gh');
  assert.ok(!masked.includes('nkrumah') && !masked.includes('ghanapost'), masked);
});

test('evidence renders as ordered, labelled plain text', () => {
  const rows = fmt.formatRiskEvidence({
    assessmentId: 'risk_abc', referenceId: 'ord_1', score: 55, amount: 20000, currency: 'GHS',
    reasons: ['checkout_velocity', 'payment_failures', 'brand_new_reason'],
  });
  assert.deepEqual(rows.map((r) => r.key), ['reasons', 'score', 'amount', 'referenceId', 'assessmentId']);
  assert.equal(rows[0].label, 'Why it was flagged');
  assert.equal(rows[0].value, 'Many checkouts in 10 minutes (5+), Several failed payments in 30 minutes (3+), Brand new reason');
  assert.equal(rows[1].value, '55');
  assert.equal(rows[2].value, 'GHS 20,000.00');
});

test('evidence never carries markup semantics and survives hostile or odd shapes', () => {
  const rows = fmt.formatRiskEvidence({
    note: '<img src=x onerror=alert(1)>\u0000\u0007',
    nested: { deeper: { deepest: { tooDeep: 1 } }, flag: true, nothing: null },
    list: [{ a: 1 }, { b: 'two' }],
    empty: [],
    huge: 'x'.repeat(5000),
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  // Returned as inert text (React escapes it); control characters stripped.
  assert.equal(byKey.note.value, '<img src=x onerror=alert(1)>');
  assert.equal(byKey['nested.flag'].value, 'Yes');
  assert.equal(byKey['nested.nothing'].value, '—');
  assert.equal(byKey['nested.deeper.deepest'].value, '[nested data]');
  assert.equal(byKey['list.0.a'].value, '1');
  assert.equal(byKey['list.1.b'].value, 'two');
  assert.equal(byKey.empty.value, 'None');
  assert.ok(byKey.huge.value.length <= 500);
  assert.ok(rows.every((r) => typeof r.value === 'string' && typeof r.label === 'string'));
  assert.deepEqual(fmt.formatRiskEvidence(null), []);
  assert.deepEqual(fmt.formatRiskEvidence('just text'), [{ key: 'value', label: 'Value', value: 'just text' }]);
  const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
  assert.equal(fmt.formatRiskEvidence(many).length, 50, 'capped');
});

test('labels are humanized', () => {
  assert.equal(fmt.humanizeKey('assessmentId'), 'Assessment id');
  assert.equal(fmt.humanizeKey('fund_release_review'), 'Fund release review');
  assert.equal(fmt.flagCodeLabel('checkout_review'), 'Checkout needs review');
  assert.equal(fmt.flagCodeLabel('new_code'), 'New code');
});

test('risk endpoints: permission, fresh session and rate limit; decisions never moderate', () => {
  const fns = fs.readFileSync('src/modules/administration/internal/transport/admin/risk.functions.ts', 'utf8');
  const blocks = fns.split(/\nexport const /).slice(1);
  assert.equal(blocks.length, 5);
  for (const block of blocks) {
    assert.match(block, /requireAdminForUserId\(userId, "admin\.risk\.review"\)/, block.slice(0, 40));
    if (/method: "POST"/.test(block)) {
      assert.match(block, /mutationGuards\(userId, "admin-risk-/, block.slice(0, 40));
    }
  }
  assert.match(fns, /requireFreshSession\(\);[\s\S]*enforceRateLimit\(/);
  const server = fs.readFileSync('src/modules/administration/internal/risk-review.server.ts', 'utf8');
  assert.doesNotMatch(server, /admin_set_customer_blacklist|admin_set_merchant_status|moderationStatus"\s*=|update\s+merchants|update\s+orders/i,
    'a risk decision must not suspend anyone or hold orders');
  const page = fs.readFileSync('src/routes/admin/risk.tsx', 'utf8');
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
});
