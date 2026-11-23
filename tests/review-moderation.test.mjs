// Review moderation guards (migration 0233): every customer-facing read of
// reviews goes through the public_reviews view (which excludes hidden reviews),
// the reason vocabulary matches the database, and merchants have no hide path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTypeScript } from '../scripts/helpers/load-typescript.mjs';

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = walk('src').filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !f.endsWith('routeTree.gen.ts'));
const rel = (f) => f.split(path.sep).join('/');

/** The only server code allowed to read the raw reviews table (it must see hidden reviews). */
const RAW_REVIEW_READERS = new Set(['src/modules/engagement/internal/review-moderation.server.ts']);

test('application code reads reviews only through public_reviews', () => {
  const offenders = sources.filter((f) => !RAW_REVIEW_READERS.has(rel(f)))
    .filter((f) => /\b(from|join)\s+reviews\b/i.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(offenders, []);
});

test('only the admin moderation module can change moderation state', () => {
  const writers = sources
    .filter((f) => /update\s+reviews\s+set|moderation_status\s*=\s*'hidden'|update\s+review_reports\s+set/i.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(writers, ['src/modules/engagement/internal/review-moderation.server.ts']);
  const transport = fs.readFileSync('src/modules/engagement/internal/transport/admin/review-moderation.functions.ts', 'utf8');
  for (const name of ['hideReviewAdmin', 'restoreReviewAdmin', 'dismissReviewReportsAdmin']) {
    const body = transport.slice(transport.indexOf(`export const ${name}`)).split(/\nexport const /)[0];
    assert.match(body, /requireAdminForUserId\(adminId, CAPABILITY\)/, `${name} checks admin.reviews.moderate`);
    assert.match(body, /guardMutation\(d, adminId\)/, `${name} requires a fresh session and rate limit`);
  }
  assert.match(transport, /const CAPABILITY = "admin\.reviews\.moderate"/);
  assert.match(transport, /requireFreshSession\(\)/);
  assert.match(transport, /enforceRateLimit\("admin-review-moderation"/);
});

test('customer report endpoint is customer-only and rate limited to 10 per hour', () => {
  const src = fs.readFileSync('src/modules/engagement/internal/transport/review-reports.functions.ts', 'utf8');
  assert.match(src, /requireCustomerForUserId\(userId\)/);
  assert.match(src, /enforceRateLimit\("review-report", \{ windowSeconds: 3600, maxRequests: 10, subject: userId, identity: "subject" \}\)/);
});

test('reason list matches both CHECK constraints in the migration', () => {
  const { REVIEW_MODERATION_REASONS, REVIEW_MODERATION_REASON_LABELS } = loadTypeScript('src/modules/engagement/internal/review-moderation.shared.ts');
  const sql = fs.readFileSync('migrations/0233_review_moderation.sql', 'utf8');
  const lists = [...sql.matchAll(/(?:hidden_reason is null or hidden_reason|reason) in \(([^)]*)\)/g)]
    .map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
  assert.equal(lists.length, 2);
  for (const list of lists) assert.deepEqual(list, [...REVIEW_MODERATION_REASONS]);
  assert.deepEqual(Object.keys(REVIEW_MODERATION_REASON_LABELS), [...REVIEW_MODERATION_REASONS]);
});

test('every SQL aggregate over reviews filters out hidden reviews', () => {
  const sql = fs.readFileSync('migrations/0233_review_moderation.sql', 'utf8');
  for (const fn of ['calculate_product_listing_quality', 'merchant_performance_snapshot', 'recalculate_merchant_health_score']) {
    const start = sql.indexOf(`FUNCTION public.${fn}(`);
    assert.ok(start > 0, `${fn} is redefined`);
    const body = sql.slice(start, sql.indexOf('$function$;', start));
    assert.match(body, /moderation_status\s*=\s*'published'/, fn);
  }
});
