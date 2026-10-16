# Delivery staging and coordinated cutover — release hold

This development candidate is not authorized for public deployment or real-money operations. The separate CTO report and evidence archive record the exact checks executed on 2026-10-15.

## Schema and compatibility

There are 201 main deployment migrations through 0202 and one nested, opt-in authentication migration. Historical files through 0199 retain their original bytes. Additive migrations 0200–0202 repair receipt deletion/rewrite, consumed-verifier mutation, concurrent allocation, shipment identity, receipt timestamps, protection deadlines and graph mutation locking.

0196 changes delivery-job uniqueness and handover/request primary keys to job scope. Old dispatch code using `ON CONFLICT(order_id)` is incompatible. Never run old application code or workers against this schema.

The runner verifies checksums, takes an advisory lock, and commits each file separately with its ledger entry. A failure rolls back the current file; earlier files remain applied. The whole chain is not one transaction.

## Preserve the operational baseline

1. Keep the current production application/database untouched until staging acceptance. Save its exact package, configuration and migration ledger.
2. Take an encrypted backup and prove restoration separately. This run did not verify your production backup/recovery process.
3. Restore sanitized representative data to isolated staging. Reconcile applied checksums. Missing historical checksums deliberately block the runner; never invent them from today's source.
4. Include old delivery jobs, partial shipments, receipts, payments, refunds and disputes. The synthetic fixture is a regression test, not representative production evidence.
5. Quiesce dispatch, invitation, payment, settlement and webhook workers during cutover. Drain requests. Run the compatible migration runner and application together. Reopen traffic only after acceptance.
6. Before traffic resumes, failed acceptance requires restoring the verified database and matching old application together. After new receipt/financial activity exists, reconcile on a clone and use a reviewed forward repair; never restore away new evidence.

## Reproduce checks

Use Node 22 and PostgreSQL 18. Install with `npm ci`, then run typecheck, lint, architecture, module contracts, provider neutrality, deployment-package validation, `npm test` and build.

For database tests, explicitly set `ELEMARKET_TEST_DATABASE_URL` to a disposable database named `elemarket_test_*`. Run the production migrator with `DATABASE_URL` pointing there, then `npm run test:fulfillment:postgres`. Fixture preparation intentionally bypasses row triggers to restore historical states; mutations under test enable all guards. Never use production.

For a historical upgrade, create a fresh disposable database, set `ELEMARKET_TEST_DATABASE` and `ELEMARKET_TEST_THROUGH=0195`, then run `node scripts/verify-postgres-chain.mjs`. Apply `tests/historical-delivery-fixture.sql`, run the production migrator, then apply `tests/historical-delivery-assertions.sql` using `psql -X -v ON_ERROR_STOP=1`. The helper defaults to local port 55439 and user `elemarket_test`.

For HTTP tests, start the built server in `ELEMARKET_ENV=development` with isolated PostgreSQL, local Better Auth origin/secret and test CRON_SECRET. Set `ELEMARKET_TEST_ORIGIN`, `ELEMARKET_TEST_DATABASE_URL` and matching `ELEMARKET_TEST_WORKER_SECRET`; run `npm run test:runtime`. Do not configure email transport: the worker test must fail locally without sending mail. Run `npm run test:runtime:browser` with installed Edge, or set another installed Playwright channel using `ELEMARKET_TEST_BROWSER_CHANNEL`.

Local runtime tests intentionally bypass the shared-environment startup wrapper. They do not certify production startup, HTTPS proxy, Redis or external adapters.

## Operations and outstanding acceptance

The portable scheduler includes `/api/internal/rider-invitations` every minute with signed authentication. The worker uses leases, refreshes before each transport call, caps attempts at five, and exposes expired final attempts as failures. Gateway acceptance does not mean inbox delivery. Crash-after-acceptance safety still requires proof of provider idempotency retention; exactly-once external email is unverified.

New verified shipments record separate immutable 24-hour protection deadlines. Historical deadlines are not fabricated. Order-wide settlement eligibility remains conservative. Database flags do not prove external settlement holds.

Keep the release hold for pickup locations/individual attendants, explicit manager organization selection, simultaneous independent staff capabilities, automated shipment allocation and its UI, authorized phone recovery, item-linked partial returns/refunds, and independently enforceable external rider delegation. Partners lacking that identity contract must use individually authenticated ELEMARKET rider accounts.

Also required: representative restored-data testing, full rider/OTP and pickup browser acceptance, the complete failure-injection matrix, external SMS/email/payment evidence and settlement contracts, original omitted regression suites, and Docker/VPS validation. Docker is unavailable here. Deferred biometric work remains unchanged.
