# Marketplace verification

Run verification with no launch-profile variables. Marketplace operations require
authorized users and configured, active adapters. Missing payment or delivery
capabilities must fail closed. Do not enable unverified facial login.

## Deeper remediation verification — 2026-10-14 UTC

This second pass traced provider selection through initialization, independent transaction
verification, deposit confirmation, order replay, delivery updates and scheduled recovery.
The first pass removed the beta gates; the following additional defects were reproduced
or confirmed in the execution paths and corrected directly in source:

- Real payment/delivery providers with missing configuration silently selected preview
  adapters in development. Only explicitly named preview providers now use those adapters;
  shared preview providers and missing real-provider credentials fail closed.
- Initialization responses could directly mark financing deposits paid. Both ordinary
  payment and deposit initialization now remain pending until verified confirmation.
- Nonterminal refund events carried a neutral completed status and could falsely confirm
  a deposit. They are ignored for deposits; nonfinite verification amounts are rejected.
- New-charge readiness now checks duplicate-safe initialization, transaction verification,
  signed webhook support, configured checkout hosts and the canonical callback origin.
  Required direct settlement support, customer email and merchant account availability
  are checked before creating an attempt or acquiring its initialization lease.
- A separate unpaid-order count rejected idempotent retries at the reservation limit.
  Quotas remain enforced inside the existing locked SQL transaction. Every checkout replay
  now returns the same owned, authoritative product/delivery/discount totals as a new order.
- Financing return/preview pages accessed window during server rendering. They now read
  validated router search state and render on the server without a browser global.
- Production delivery updates now require the assigned provider to be active and in the
  production environment, in addition to partner ownership and optimistic version checks.
- Lost deposit webhooks now have bounded, readonly provider verification and recovery,
  using the same transactional event application as webhooks. Advisory locks and event
  hashes prevent concurrent duplicate confirmation. Recovery is called by the existing
  signed payment-reconciliation job; unsigned access remains rejected.
- Startup now rejects missing authentication proxy identity, short scheduler/sync secrets,
  shared preview settlement and invalid callback origins independently of old API-mode flags.

Verification performed against the corrected source:

- Existing 22 unit, 12 PostgreSQL integration and 13 authorization tests passed.
  Four biometric contract tests passed; facial authentication remains uncertified and disabled.
- Sixteen additional real-PostgreSQL commerce regressions passed: concurrent initialization,
  no attempts for unavailable prerequisites, ownership, false initialization completion,
  refund-progress isolation, nonfinite verification, verified webhook replay, lost-webhook
  recovery under concurrency, real-provider preview rejection, quota-safe replay, complete
  review totals, unavailable method suppression and ordinary pending order state.
  Only external provider/session boundaries were substituted. Real SQL transactions,
  constraints, row locks and business handlers executed; no real-money operation occurred.
- Real delivery handler checks passed for suspended/sandbox rejection, active production
  acceptance, atomic audit persistence and stale-version rejection.
- Production type checking and frontend/SSR/backend compilation passed with old beta
  variables absent. Existing bundler warnings were retained; emitted client bundles did
  not contain the new payment-readiness/deposit SQL implementation. A dependency reference
  to the environment-variable name BETTER_AUTH_SECRET is not an embedded secret value.
- Sixteen Edge browser checks passed at 1280px and 390px across all five portals,
  checkout and both financing return pages, without horizontal overflow or SSR failures.
  Production startup and restart passed. Unknown/cross-portal hosts returned 404; unsigned
  payment reconciliation returned 401; financing return pages returned 200 with CSP.
- Architecture/provider neutrality, all 186 immutable migration checksums and workflow
  YAML/inline JavaScript syntax passed. The 16 commerce regressions were embedded in the
  existing CI workflow so they remain reproducible without creating new test files.

The mobile audit still reports 21 high and 14 moderate vulnerabilities. Its proposed fixes
require major Expo/React Native changes, including an Expo 55 to 44 downgrade; those were
not forced into this remediation. Docker remains unavailable here, and dependency signature
verification remains unresolved. Remote GitHub Actions and real provider certification were
not performed. These limitations prevent a blanket production-readiness claim.

The updated ZIP intentionally excludes test suites, test files, dependencies and generated
builds. CI and test commands require the full developer checkout, whose existing suites
remain intact; the test-free ZIP is for source/deployment use. No release gates were disabled.

## Current remediation verification — 2026-10-14 UTC

The launch-profile module, commerce assertions, frontend beta banner/checkout replacement,
Compose/Docker defaults and CI profile assumptions were removed. All seven scheduler jobs
are restored. Administrator/provider status, authorization, adapter readiness, signed
webhooks and verified transaction state remain authoritative. Selected providers are
validated individually; an absent optional capability does not disable the whole platform.
Checkout matches the provider selected by the existing SQL transaction and requires a
configured adapter with duplicate-safe initialization before offering a payment method
or reserving an order. No migrations or authentication architecture were rewritten.

Executed on Windows with Node 22.23.3 for production compilation, unit tests and runtime:

- Root dependency installation: passed; root dependency audit: zero vulnerabilities.
- TypeScript: passed. ESLint: zero errors, nine pre-existing warnings.
- Unit tests: 22 passed. Database/concurrency/OTP tests: 12 passed.
- Authorization/tenant/merchant/provider/support tests: 13 passed.
- Biometric contract tests: four passed; this does not certify face authentication.
- Architecture, public module contracts and provider neutrality: passed.
- All 186 PostgreSQL migrations applied to a disposable PostgreSQL 18.6 instance;
  migration checksums and repeat migration execution passed. No production database used.
- Production frontend, SSR and Nitro backend compilation: passed. Compiler emitted
  dependency externalization/eval/chunk-size warnings; these were not suppressed.
- Startup and restart with old beta variables absent: passed.
- HTTP checks: all five portal entry points and checkout return 200 with CSP;
  unknown hosts and marketplace access to admin return 404.
- Edge browser: homepage, merchant onboarding, provider signup, both admin portals
  and checkout passed at 1280px and 390px without horizontal overflow or beta replacements.
- Inline regression checks: absent payment methods cannot create orders; adapter readiness
  and customer authorization are enforced; shared preview/payment/delivery adapters reject
  unavailable credentials. No live charge, refund or fulfillment was attempted.
- Synthetic EIDE evaluation: completed; results are not customer conversion evidence.

Remaining verification limitations:

- Docker construction/Compose could not run: Docker is not installed on this host.
- Dependency signature verification failed: registry could not resolve jiti@2.8.0.
- Optional mobile dependency audit failed: 21 high and 14 moderate vulnerabilities.
  No breaking Expo/React Native downgrade or forced audit fix was applied.
- Full authenticated purchase/provider certification and remote GitHub Actions execution
  were not performed. Browser checks covered public entry points, not complete account
  onboarding or a real-money purchase. Existing release limitations remain applicable.
- Earlier trial checks failed for incomplete isolated secrets/proxy headers and stale beta
  test expectations; corrected fixtures/expectations passed on rerun. No test was skipped.

Regression scripts ran through standard input; no new test files were added. Existing
repository test suites were retained and their obsolete beta expectations updated.
The temporary database, proxy, server processes and browser were shut down after testing.

## Reproducible local checks

Use Node 22 and npm 10. Install root dependencies with `npm ci`.

```
npm run check:architecture
npm run validate:deployment-package
npm run security:ci
npm run typecheck
npm run lint
npm test
python3 -m unittest discover -s integrations/executive-pad -p test_engine.py
```

The PAD tests exercise signatures, replay handling and fail-closed behavior with
synthetic frames. They do not test the neural models, actual cameras or spoof
resistance and cannot authorize facial login.

For a fresh disposable PostgreSQL database, set `DATABASE_URL`, the documented
startup configuration, then run `npm run db:migrate`. Do not change migration
files or stamp unknown historical checksums to pass the gate. Missing checksums
require historical evidence and a reviewed reconciliation.

```
RUN_DB_INTEGRATION=1 ELEMARKET_INTEGRATION_DATABASE_URL="$DATABASE_URL" \
  npm run test:integration:concurrency
```

Integration tests require a loopback database with a name ending in `_test` and
an isolated `BETTER_AUTH_SECRET`. They exercise PostgreSQL checkout races,
rollback, migration history, and email/phone OTP persistence. Email/SMS adapter
responses and request context are explicit substitutions in OTP database tests;
they are not provider delivery certification. Never point the tests at a shared
customer database. Checkout fixtures remain in the disposable integrity database;
destroy that database after testing.

The additional `npm run test:integration:authorization` suite requires all five
portal host variables, `ELEMARKET_PORTAL_HOST_ROUTING=1`, and an executive ID.
It also checks real PostgreSQL moderation timestamps against their string API contract.
It exercises real handler authorization and PostgreSQL for merchant writes/audit
rollback, inventory races, delegated staff provisioning/session revocation,
support IDOR rejection, and provider membership. HTTP session resolution,
freshness and rate limits are explicitly substituted; this is not a browser or
TOTP test. Audit events for synthetic fixtures remain in the disposable database.

## Browser and authentication checks

The current browser scripts use `coderabbit-agent-browser`, the shared browser in
the audit sandbox. They require the five `elemarket.localhost` portal hosts,
local HTTPS ingress, synthetic PostgreSQL, and a running production build. They
are not executed by the GitHub Actions workflow.

- `tests/frontend.e2e.mjs`: desktop/mobile entry pages and capability availability.
- `tests/discovery-browser.e2e.mjs`: search/refresh, product detail, cart persistence,
  mobile layout, API input rejection and absence of a beta checkout replacement.
- `tests/signup.e2e.mjs`: customer signup, OTP, profile save/reload and cookie isolation.
- `tests/provider-signup.e2e.mjs`: provider signup and pending manual application.
- `tests/merchant-signup.e2e.mjs`: merchant onboarding and unavailable-SMS recovery.
- `tests/merchant-workspace.e2e.mjs`: authenticated merchant product creation,
  editing, inventory, archive, refresh and rejected-form preservation.
- `tests/staff-workspace.e2e.mjs`: real password/TOTP, support-only navigation,
  forbidden HR route, executive host isolation and suspension.
- `tests/provider-workspace.e2e.mjs`: activated synthetic organization, both
  empty workbenches, refresh, mobile layout and suspension. No execution claim.
- `tests/auth.integration.mjs`: Better Auth/TOTP over HTTPS and PostgreSQL. Requires
  `ELEMARKET_TEST_CA`, executive host ending in `.localhost`, and the explicitly
  synthetic executive user ID `audit-executive`. Recreates only that fixture;
  includes one-use recovery-code login and replay rejection. Set
  `ELEMARKET_EXECUTIVE_BROWSER=1` for the separate executive browser journey.
  These modes are separate to respect the five-login-per-minute rate limit;
  allow the real limiter window to expire between repeated fixtures.
- `tests/runtime.integration.mjs`: a real Redis command and natural process exit.
- `tests/shutdown.integration.mjs`: production startup, health and graceful exit
  on port 8083. Requires local PostgreSQL and the local portal domain.

Stop the running server **before** replacing `.output`, then restart and verify
readiness. A server retaining an old module manifest cannot safely load newly
built chunks. Deployment must switch immutable images rather than overwrite a
running application's build directory.

### Local email simulation

Use CodeRabbit emulate release `v0.0.1` with its `resend` service. Its inbox contains
synthetic verification codes: keep it private and never expose it through public
ingress. No real email is sent. Select `ELEMARKET_EMAIL_PROVIDER=resend`, use a
synthetic local API key/from address, and set `RESEND_BASE_URL=http://127.0.0.1:4010`.
This adapter override is restricted to explicit development, preview or staging
and literal loopback HTTP origins. Production rejects it. Never use genuine
provider credentials with an emulator.

An emulator can verify the application's delivery contract and onboarding logic;
it cannot verify ownership of a real user's email. SMS delivery has not been
verified; the installed emulator catalog has no matching Arkesel service.

## Optional native client

```
npm ci --prefix mobile
npm run typecheck --prefix mobile
cd mobile
node node_modules/expo/bin/cli install --check
node node_modules/expo/bin/cli export --platform android --output-dir /tmp/mobile-export
npm audit --audit-level=high
```

The inspected mobile dependency graph currently fails the vulnerability gate
(35 affected packages, five root advisories). A nonbreaking `npm audit fix` did
not resolve it. Do not force npm's suggested Expo downgrade or unsupported SDK
upgrade. An Android JS/Hermes export is not native installation or device testing.

## Deployment evidence and remaining gates

A fresh isolated Compose deployment passed PostgreSQL,
Redis, app and scheduler health, seven CA-verified TLS/portal probes, signed
scheduler execution and 186 migrations. The app runs as a nonroot user with all
Linux capabilities dropped. Internal services publish no ports. A logical dump
was actually restored and compared across 203 public tables. Candidate restart
regained readiness in 12.6 seconds. A prior-image smoke test verified startup
against the current schema in the private network and restoration of the exact
candidate image; it does not certify every old-version operation.

Sandbox accommodations were explicit: use the task Docker socket, Buildx 0.29.1,
loopback 9080/9443 ingress, private synthetic env_file and a byte-identical Caddyfile
copy outside the encrypted workspace mount. No public DNS/certificate or VPS
failure recovery was tested. See [deployment/recovery](deployment.md).

The current evidence does not establish every authenticated browser workflow,
all upload/webhook/SSRF permutations, native-device behavior or sustained capacity.
Public email/phone ownership verification and storage integrations have not been
certified; local email delivery is a simulation. Mobile registry auditing and the local fork advisory regression checks pass;
native device security remains uncertified. Loss of TOTP plus all recovery codes has no verified recovery procedure.
GitHub Actions and branch protection have not been verified remotely. No public
deployment is certified, and these gaps must not be counted as passed gates.


## Public-release restriction cleanup � 2026-10-15

Authentication no longer has a developer identity fallback. The legacy auth-off
flag cannot disable real sessions. Preview commerce requires explicit opt-in,
never reactivates inactive provider records, and delivery has no automatic mock
fallback. Public portal links are configured without fixed subdomain guesses.
The public terms no longer label the service beta. Local analytics uses a random
process key rather than a fixed secret. Migration 0188 quarantines unclaimed
historical sample inventory with original-row snapshots; owned/order-linked shops
are preserved and need normal operator verification, rather than automatic changes.

Validated: typecheck; 22 unit tests; 12-module architecture checks; all 187 migration
checksums; full migration execution on embedded PostgreSQL; cleanup preserves
ownership and order history and safely reruns; session, preview and custom-domain
regressions. These additional regressions are embedded in CI, with no new test
files. The feature-flag scanner reported no flags; manual tracing found the
behaviors fixed here, so scanner absence is not treated as release proof.

See release-assessment.md for the current source/deployment distinction.
