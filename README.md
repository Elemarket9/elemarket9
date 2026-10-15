# ELEMARKET — Modular Marketplace

ELEMARKET is a modular monolith with a React/TanStack Start web application,
Better Auth, PostgreSQL and optional Redis. EIDE provides catalog search,
ranking and discovery. The separate `mobile/` directory contains an optional
Expo client; `integrations/` contains optional provider and biometric bridges.

Marketplace features use backend authorization, active provider records and validated
adapters. Configure providers independently; unavailable capabilities fail closed.
Executive facial login remains unavailable in shared environments; Better Auth
+ TOTP remains operational.

See [release assessment](docs/release-assessment.md),
[verification commands and limitations](docs/verification.md) and
[deployment/recovery procedures](docs/deployment.md). Historical
test counts and claims from earlier README revisions are not release evidence.
Authentication always uses real sessions. Preview commerce requires an explicit
isolated development opt-in; a new public database has no active sample inventory.
Portal origins are derived from the configured portal hostnames during the build.

## Development

Use Node.js 22.x and npm. The isolated development preview can use PGlite with
pgcrypto; staging/production require an explicit PostgreSQL connection.

```sh
npm ci
npm run check:architecture
npm run typecheck
npm run lint
npm test
npm run build
```

For configured shared environments, `npm run build:production` validates runtime
and client configuration before building. `npm start` verifies the migration
manifest, validates the environment and applies pending migrations before
starting Nitro. Stop the server before rebuilding `.output` locally. Deployments
should switch immutable images instead of overwriting a running build directory.

Run PostgreSQL integration tests only against a disposable local database ending
in `_test`, with `RUN_DB_INTEGRATION=1`, `ELEMARKET_INTEGRATION_DATABASE_URL` and an
isolated `BETTER_AUTH_SECRET`; see the verification guide. Tests retain synthetic
checkout fixtures. Destroy the disposable database after testing.

## Architecture

Business capabilities live in `src/modules/<module>/internal`, exposed through
thin `public` re-export contracts. Cross-module imports must use those contracts.
The architecture checks reject private imports and module dependency cycles.
Routes provide UI/HTTP transport; domain operations stay in their modules.
Payment webhook integration is composed in `src/application/payment-webhook.server.ts`.

Provider choices belong in adapters and configuration. The authoritative
capability/credential registry is `config/provider-capabilities.json`. Provider
credentials and encryption keys must remain server-only, never in `VITE_*` values,
browser bundles, logs or source control.

## Five portals

Enable `ELEMARKET_PORTAL_HOST_ROUTING=1` and configure distinct hostnames:

| Configuration | Portal |
| --- | --- |
| `ELEMARKET_DOMAIN` | Public marketplace |
| `ELEMARKET_EXECUTIVE_HOST` | Provisioned Main Admin |
| `ELEMARKET_STAFF_HOST` | Employee administration |
| `ELEMARKET_SELLER_HOST` | Merchant portal |
| `ELEMARKET_PROVIDER_HOST` | Financing/delivery provider portal |

Set `ELEMARKET_EXECUTIVE_USER_ID` to the provisioned database identity and
`BETTER_AUTH_URL` to the canonical HTTPS marketplace origin. Domains are
configuration, not authentication secrets. The application and Caddy enforce
host/path separation; handlers still enforce roles and ownership. Browser auth
requests must originate on their receiving portal. Cookies remain host-only.

`compose.yaml`, `compose.portals.local.yaml`, `infra/Caddyfile`, and
`infra/Caddyfile.local` describe single-VPS and local ingress. Intended production
hostnames do not establish DNS ownership or TLS readiness. Set proxy-trust flags
only behind ingress that overwrites client-supplied forwarded headers.

## Optional external adapters

- Email/OTP: select `ELEMARKET_EMAIL_PROVIDER`; the current email adapter is
  Resend (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`, optional `RESEND_REPLY_TO`).
  `/api/email/webhook` uses `RESEND_WEBHOOK_SECRET`. Local synthetic email testing
  supports a restricted `RESEND_BASE_URL`; see the verification guide.
- SMS: select `ELEMARKET_OTP_PROVIDER` and its registry-defined credentials.
  An unavailable SMS service leaves merchant applications pending; it does not
  grant phone verification or merchant access.
- Push: browser and server provider selections must agree when configured.
  FCM service-account JSON is server-only. Both selections may be absent when push is unavailable.
- KYB: a configured adapter supplies supporting evidence. Final merchant approval
  remains an administrative decision subject to database verification constraints.
- Location, storage, payment, financing and delivery: use the selected adapter's
  configuration. Live credentials are unnecessary for the isolated audit tests.

## Transactions and workers

ELEMARKET does not custody customer funds. Provider-managed settlement/refunds
are available only when their configured adapters and authorization allow them.
The bundled payment adapter does not assert safe checkout-initialization replay
or uncertain-refund reconciliation. Do not enable live checkout on the basis of
compilation or simulated provider tests.

`scripts/scheduler.mjs` invokes the approved job catalog over the private network.
All scheduled jobs run; each handler enforces its prerequisites. With portal routing, configure
`ELEMARKET_DOMAIN` for the scheduler's Host header. It signs requests using the
path/method/body-bound protocol in `scripts/scheduler-core.mjs`; worker handlers
validate signatures and consume nonces. Keep scheduler secrets out of URLs.
Authenticated worker limits use a fixed scheduler subject.

## Database history

Migration SQL and `migrations.sha256.json` are immutable release inputs. The
migrator rejects checksum drift and missing historical checksums. Earlier source
history states that migrations 0041 and 0105 were rewritten before this audit;
original deployed versions were not available for independent comparison.
Fresh database initialization does not certify upgrades from those unknown
historical schemas. Reconcile existing deployments from their backups and schema
history through a reviewed migration plan; never stamp current checksums onto
unverified history.

## EIDE and optional clients

EIDE retrieves PostgreSQL catalog candidates, interprets bounded queries and
ranks results using catalog quality and behavioral signals. It does not authorize
payments, orders or tenant access. `npm run test:eide` runs query regressions;
`npm run evaluate:eide` uses a synthetic evaluation dataset, not customer metrics.

See [mobile setup](mobile/README.md) and [experimental PAD limitations](integrations/executive-pad/README.md).
Mobile registry auditing and local security regression checks pass; local forks
require maintenance. PAD contract tests do not validate
biometric matching, liveness or resistance to spoofing. Keep facial login off.

The source repository is private. Public marketplace access does not authorize public
source publication. No version bump, tag or public deployment is implied by this
working branch.

## Source ZIP packaging

The corrected source ZIP intentionally omits test suites, installed dependencies and generated
builds. Install dependencies and build from source. Full tests and GitHub verification require
the developer checkout with its existing suites; missing suites fail their gates rather than
being skipped. See docs/verification.md for the deeper checks and unresolved release limits.
