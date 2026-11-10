# Production readiness: 2026-11-10

Branch `upgrade/real-world-readiness`, based on `main` at df1bbfe. This report covers three areas: the supply chain, database proof, and a full-stack rehearsal. Payment, payout and SMS providers are **simulated** throughout, and no real money or messages were sent.

## What changed

| Area | Change |
|---|---|
| Runtime | Node 26 in production: Dockerfile `node:26-bookworm-slim`, render.yaml, CI. Engines accept `22.x \|\| 26.x`. The mobile build stays on 22. |
| Dependencies | 163 packages upgraded. `npm audit` reports 0 vulnerabilities for the web app. Overrides remove the vulnerable `minimatch`/`glob` paths. Mobile has 7 low findings left (`deepmerge`, which has no fixed release). |
| CI supply chain | `actions/checkout` and `actions/setup-node` are pinned to verified commit SHAs. The signature gate retries only the registry's transient missing-key error and fails closed on everything else. |
| Scheduled jobs (defect) | Two enterprise jobs failed on **every** run in production. **Fixed.** See below. |
| CI coverage | CI now runs the PostgreSQL suites (wallet, database operations, commerce integrity, scheduled jobs). Before, it only applied migrations. |
| Post-deploy check | New `scripts/smoke-deployment.mjs`. Run it after each deploy. |

### Defects found in the rehearsal

1. **Enterprise order outbox and enterprise webhook worker never ran.** The scheduler signs every job with `CRON_SECRET`. These two routes only accepted `ELEMARKET_ENTERPRISE_SYNC_SECRET`, and the startup validator requires that to be a different secret. Result: a 401 every minute, and merchant ERP integrations never received order events.
   - Scheduled GET routes now also accept the scheduler's replay-protected HMAC proof.
   - That grants nothing beyond the bearer token those paths already accept.
   - Manual and POST callers still need the enterprise secret.
2. **The outbox claim query was invalid SQL.** It used `'ed_' + text` where it needed `||`. It failed at parse time even with nothing queued, and the route swallowed the error.
   - Fixed, and both routes now log the cause.

Regression test: `tests/scheduled-jobs.postgres.mjs` fails 3/3 on the old code and passes 3/3 on the fix.

## What is proven

All results below are under Node 26.13.0 with PostgreSQL 16.

| Check | Result |
|---|---|
| Unit tests, typecheck, lint, architecture and provider-neutrality guards, startup validation, deployment package, production build | pass (46/46 tests) |
| `npm run test:wallet:postgres` | 32/32, including T22 with a real database restart |
| `npm run test:db:postgres` | 15/15 |
| Migrations | Fresh replay and no-op rerun pass. 3 concurrent migrators pass. A failing migration rolls back atomically. Tampered and untracked files are refused. |
| Backup and restore drill | Dump, verify and restore into a new database. Data and schema are identical. Append-only guards survive. Ledger invariants hold. |
| Stock contention | 20 buyers for 5 units: exactly 5 orders, no oversell |
| Idempotency | A checkout submitted 10 times makes 1 order. 10 duplicate payment webhooks complete the payment once. |
| OTP and identity | Guessing is capped and locks the challenge. A code verifies once and only for its own account. A direct phone swap is blocked. |
| Authorization | Merchants cannot cross into other merchants. Customers and merchants are not admins. Suspension removes access. |
| Full stack: Caddy TLS, app, scheduler, Redis, Postgres | Smoke test 38/38 checks:<br>• HTTPS redirect, HSTS, CSP, nosniff, referrer policy, no version leak<br>• the five portal hosts are isolated from each other<br>• scheduler credential enforced<br>• unsigned webhooks refused |
| Scheduler | All 11 jobs succeed every round |
| Redis outage | The app stays up and health reports `cache: degraded`. Recovers by itself. |
| Postgres outage | Health returns 503 `database: down`, so the load balancer pulls the instance. The process stays up and reconnects with no restart. |

Not verifiable from the build sandbox: `npm audit signatures`, because the Sigstore trust root is blocked there. CI runs it with full network access.

## What only the owner can do

These are required before taking real orders:

1. **Payment provider.** Activate at least one payment provider with test keys first, then live keys.
   - Until then the payment webhook answers 503. The smoke test flags this as a warning.
   - Run a sandbox charge, refund and payout end to end.
2. **Payout provider.** Configure a payout driver for merchant withdrawals. Until then `wallet-settlement` reports `payoutsConfigured: false`.
3. **Licensing.** Confirm the Bank of Ghana position for holding and paying out merchant funds. The provider holds the funds, but this still needs confirming.
4. **Infrastructure.** VPS, DNS for the five hosts, and real TLS certificates. After deploy, run:
   ```
   ELEMARKET_DOMAIN=… ELEMARKET_SELLER_HOST=… ELEMARKET_STAFF_HOST=… \
   ELEMARKET_EXECUTIVE_HOST=… ELEMARKET_PROVIDER_HOST=… CRON_SECRET=… \
   node scripts/smoke-deployment.mjs
   ```
5. **Single-vendor exposure.** SMS/OTP (arkesel), email (resend) and storage (r2) each have one registered provider. Register a second for SMS/OTP at least, since login depends on it.
6. **Mobile.**
   - Sign the release APK and test on real devices.
   - The Expo SDK 55→58 upgrade needs device testing.
   - 7 low `deepmerge` advisories are waiting on an upstream fix.
7. **Executive-face add-on.** Still on Node 22. Move it to 26 when you next touch it.
8. **Backups in production.** Schedule `pg_dump` with off-site copies. Run the restore drill (`tests/database-operations.postgres.mjs`) against a copy each quarter.
