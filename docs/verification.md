# Developer Beta verification

This branch is under audit. It is **not certified for public release**. Use the
`developer_beta` launch profile in a shared environment. It disables ordering,
payments, refunds, financing execution and dispatch. Do not enable facial login.

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

- `tests/frontend.e2e.mjs`: desktop/mobile entry pages and disabled beta features.
- `tests/discovery-browser.e2e.mjs`: search/refresh, product detail, cart persistence,
  mobile layout, API input rejection and beta checkout restriction.
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
certified; local email delivery is a simulation. Mobile dependency security still
fails. Loss of TOTP plus all recovery codes has no verified recovery procedure.
GitHub Actions and branch protection have not been verified remotely. No public
deployment is certified, and these gaps must not be counted as passed gates.
