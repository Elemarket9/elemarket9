import test from 'node:test';
import assert from 'node:assert/strict';
import { healthcheckPasses } from '../scripts/app-health.mjs';
import { parsePgInt8 } from '../src/lib/pg-int8.mjs';
import { isDatabaseUnavailable } from '../src/lib/db-unavailable.mjs';
import { safeErrorFields } from '../src/lib/observability/safe-error.mjs';

test('compose healthcheck requires a database check and ignores cache degradation', () => {
  assert.equal(healthcheckPasses(200, JSON.stringify({ ok: true })), false);
  assert.equal(healthcheckPasses(200, JSON.stringify({ ok: true, checks: { database: 'ok', cache: 'degraded' } })), true);
  assert.equal(healthcheckPasses(503, JSON.stringify({ ok: false, checks: { database: 'down', cache: 'unconfigured' } })), false);
  assert.equal(healthcheckPasses(200, 'not-json'), false);
});

test('int8 stays exact past the JavaScript safe integer range', () => {
  assert.equal(parsePgInt8('42'), 42);
  assert.equal(parsePgInt8('-7'), -7);
  assert.equal(parsePgInt8('9007199254740993'), '9007199254740993');
  assert.equal(parsePgInt8('not-a-count'), 'not-a-count');
});

test('database outages are distinguished from ordinary query errors', () => {
  assert.equal(isDatabaseUnavailable(Object.assign(new Error('connect'), { code: '57P01' })), true);
  assert.equal(isDatabaseUnavailable(new Error('timeout exceeded when trying to connect')), true);
  assert.equal(isDatabaseUnavailable(Object.assign(new Error('duplicate'), { code: '23505' })), false);
});

test('server error logs omit postgres detail and message text', () => {
  const error = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    detail: 'Key (email)=(shopper@example.com) already exists.',
  });
  const fields = safeErrorFields(error);
  assert.deepEqual(fields, { name: 'Error', code: '23505' });
  assert.equal(JSON.stringify(fields).includes('shopper@example.com'), false);
  assert.equal(JSON.stringify(fields).includes('duplicate key'), false);
});
