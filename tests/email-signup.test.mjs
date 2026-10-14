import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from '../scripts/helpers/load-typescript.mjs';

// Unit boundary test: exercise real OTP issuance logic; provider and SQL are
// explicit fakes. PostgreSQL verification is a separate integration gate.
for (const verified of [false, true]) {
  test(`signup OTP for an existing ${verified ? 'verified' : 'unverified'} account`, async () => {
    const previous = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'synthetic-unit-test-secret-32-characters';
    const writes = [];
    const delivered = [];
    const adapter = { key: 'simulation', send: async message => { delivered.push(message); return { accepted: true }; } };
    const { requestEmailOtp } = loadTypeScript('src/modules/identity/internal/auth/email/email-otp.server.ts', {
      '@/lib/db': { getSql: async () => ({ query: async (sql, params) => {
        if (sql.includes('from "user"')) return [{ id: 'new-account', emailVerified: verified }];
        if (sql.includes('select id, cooldown_until')) return [];
        writes.push({ sql, params }); return [];
      } }) },
      '@/lib/security/rate-limit.server': { enforceRateLimit: async () => {} },
      './registry.server': { getEmailAdapter: () => adapter },
    });
    try {
      if (verified) {
        await assert.rejects(requestEmailOtp({ email: 'customer@example.test', purpose: 'signup' }), /already exists/);
        assert.equal(delivered.length, 0);
      } else {
        const result = await requestEmailOtp({ email: 'customer@example.test', purpose: 'signup' });
        assert.match(result.challengeId, /^otp_[a-f0-9]{32}$/);
        assert.equal(delivered.length, 1);
        assert.equal(writes[0].params[1], 'new-account');
        assert.match(writes[0].params[8], /^[a-f0-9]{64}$/);
        assert.ok(writes[1].sql.includes("status='pending'"));
      }
    } finally {
      if (previous === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previous;
    }
  });
}
