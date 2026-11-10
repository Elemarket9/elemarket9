# ELEMARKET independent deployability audit — 2026-11-10

Scope: source review of `Elemarket9/elemarket9` default-branch tree and selected runtime paths, deployment manifests, CI, authorization policy, migrations, scheduler and Paystack adapter. No production host, private secrets, running PostgreSQL, real SMS, live payment, native device or external-provider account was available. Do **not** treat this as a full independent security penetration test or a production GO decision.

## Confirmed findings and changes

1. **P1 — GitHub root tests missing.** The audited `main` tree contains **zero tracked files under `tests/`**, though `scripts/test.mjs` demands actual test files. Existing CI ran lint/build but **did not invoke `npm test`**, so it could report success with no root test execution. This PR restores a narrow security, scheduler and migration regression set and makes the workflow run `npm test`. These new tests are **not replacements** for the missing PostgreSQL checkout, webhook, OTP, authorization, delivery, browser or native-device suites. Restore those from trusted original development files; never invent past test pass counts.
2. **P2 — unbounded Docker logs.** The deployed Compose services did not set bounded json-file log rotation. Repeated application or provider failures could consume VPS storage. This PR adds a common bounded log policy to all seven Compose services. Application DB volumes are unchanged.
3. **P1 deploy dependency — Paystack charge initialization disabled by policy.** `src/modules/payments/internal/adapters/providers/paystack.ts` declares `supportsIdempotentInitialization = false`, and `payment.server.ts` calls `assertPaymentInitializationReady`. This is a deliberate duplicate-charge protection, not a line to flip: safe retry/recovery behavior must be engineered and verified against a real/sandbox provider before enabling new charges.
4. **P1 deployment evidence gap — PostgreSQL and provider behavior.** The migration runner uses an advisory lock, manifest hashing and transactional application; these source checks were inspected, **not** replayed on a fresh PostgreSQL instance in this audit. A fresh disposable database run of the complete migration chain, repeat run, failure injection and rollback drill are still required. Sandbox webhooks, refunds, delivery handover/OTP and financial reconciliation also need runtime evidence.
5. **P1 supply-chain / mobile release gap.** Mobile Expo/React Native dependencies and maintained source forks exist in the repository; this review has not established that current advisories are cleared, or produced a signed installable APK. Require a fresh `npm audit`/native device CI run and review results, rather than relying on October 2026 audit figures.
6. **Deployment and exposure.** Compose keeps PostgreSQL and Redis unpublished and uses Caddy host segmentation and startup environment checks. `.dockerignore` excludes `.env.production` from image context. The repository itself is **public**; treat old documentation saying 'keep repository private' as historical advice, and review both Git history and current tree for leaked secrets before deployment.

## Source-verified design, not runtime-proven

- Single-VPS Compose services: `postgres`, `redis`, `app`, `scheduler`, `proxy`; biometric add-ons remain opt-in. App invokes checksum-validated, advisory-locked migration runner before opening its HTTP port.
- Five configured domain names route to separate portal host policies. Executive is bound to exact user identity and separate host; these paths now have basic regression tests.
- Provider neutrality and integration abstraction exist in source. Real delivery provider and payment subaccount settlement must be verified against actual provider contracts.
- Storage upload protection, database backup and restore, object storage, DNS/TLS, traffic/load and PSP callback validation remain deployment-specific tests.

## Required verification before real deliveries or payments

On an isolated environment with full source and test fixtures:

```sh
npm ci
npm run check:architecture
npm run validate:deployment-package
npm test
npm run typecheck
npm run lint
npm run security:ci
npm run build
# once Docker and valid configuration are available:
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production build app scheduler
```

Then run the restored full PostgreSQL integration/authorization/fulfillment tests on a disposable `*_test` database; verify migrations and repeat migrations, Redis degradation, HTTP domain isolation, OTP binding and expiry, real-provider sandbox callback signatures and replay, provider settlement/refund reconciliation, device UI and a complete simulated purchase/return. Test a backup **restore**, not just backup archive validity. Do not publish ingress until TLS, owner TOTP recovery, secrets and provider adapters have been verified.


## Actual GitHub Actions evidence on this branch

- Source and build checks: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and the separate Docker image build **passed** on PR #16, commit `321ba084`. These checks are source/build evidence, not a running deployment.
- Root `npm audit --audit-level=high` **failed**: 12 reported vulnerabilities (one critical, two high, eight moderate, one low), including current advisories affecting Better Auth, Vite, Zod and transitive packages. Security gate remains blocking.
- Mobile `npm audit --audit-level=high` **failed**: 13 reported vulnerabilities (three high, nine moderate, one low); transitive findings include Expo tooling and Zod. Mobile TypeScript and Android export **passed**, but this export is **not** a signed/tested native APK.
- CI now collects build/test evidence after a failed audit and then fails the job explicitly. No audit suppression or unsafe broad dependency downgrade was introduced.

Evidence: [Source/build workflow run](https://github.com/Elemarket9/elemarket9/actions/runs/42802422468); [Docker image workflow run](https://github.com/Elemarket9/elemarket9/actions/runs/42802422370).

## Verdict

**Deployable framework present; production use not yet verified.** The PR improves release checks and operational storage limits but does not claim to repair all unknown defects. It should pass GitHub CI and the missing full suites/real integration tests must be restored before any confident release verdict. No live money, VPS deployment, or production release was attempted.
