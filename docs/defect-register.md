# Confirmed defect and unresolved risk register

Source references identify the audited working tree, based on commit `71abe2491b1aa1d320a8f383d86ea7c91b74aa61`. Evidence names identify command logs. This is the complete register of findings confirmed in this audit, not a claim that every latent defect was discovered. P1 denotes major security, integrity or functional impact; P2 denotes reliability/usability. No P0 exploit was independently established.

## D01 — Nonreproducible root installation

**P1 · Fixed** · `package-lock.json:5808`

npm ci failed because the lockfile omitted a required lru-cache dependency. Repaired lock resolution; root clean install and Docker npm ci passed.

Evidence: `baseline install failure; repaired install and final-csp-docker-build`.

## D02 — Type and generated-route failures

**P1 · Fixed** · `src/routeTree.gen.ts:59`

Stale route generation plus invalid/narrow types and an incorrect Better Auth session call prevented type checking. Regenerated routes and corrected contracts without changing grants.

Evidence: `baseline-typecheck; final-csp-typecheck; final-csp-production-build`.

## D03 — Empty test gate falsely succeeded

**P1 · Fixed** · `scripts/test.mjs:6`

The missing tests glob returned success with zero executed tests. Added nonempty discovery and real regression suites.

Evidence: `baseline-test; unit and integration passes listed below`.

## D04 — Private portal pages accepted wrong hosts

**P1 · Fixed** · `src/start.ts:9`

Application relied on ingress for page isolation. Baseline unknown Host and marketplace /admin returned200. Application now rejects unknown hosts and private paths on other portals. Resource authorization remains separate.

Evidence: `http-portals-trusted-ingress; final-csp-portals`.

## D05 — Sibling origin could mutate executive credentials

**P1 · Fixed** · `src/lib/security/portal-policy.mjs:113`

Better Auth allowed every portal origin. A valid executive session and current password could change its password from the marketplace Origin. Added receiving-host Origin and Fetch-Metadata enforcement. This was not a passwordless takeover.

Evidence: `auth-sibling-origin-before-fix; executive-workspace-browser API assertions`.

## D06 — Signup rejected its newly created account

**P1 · Fixed** · `src/modules/identity/internal/auth/email/email-otp.server.ts:73`

Signup creates an unverified identity before requesting its code; the existence test rejected it. Only an already verified account now causes the duplicate signup error.

Evidence: `signup-regression-before-fix; customer/provider/merchant signup browser checks`.

## D07 — Email proof could commit without account verification

**P1 · Fixed** · `src/modules/identity/internal/auth/email/email-otp.server.ts:148`

OTP consumption and emailVerified update used separate commits. Fault injection stranded the account. Both now commit atomically and recheck expiry/identity.

Evidence: `email-otp-atomicity-before-fix; combined-postgres-integrity`.

## D08 — Phone proof could commit without profile verification

**P1 · Fixed** · `src/modules/identity/internal/auth/otp/otp.server.ts:165`

OTP consumption and profile confirmation were separate; selected adapter was not bound in claim SQL. Added atomic confirmation, consistent lock ordering, provider binding and expiry recheck.

Evidence: `phone-otp-atomicity-before-fix; combined-postgres-integrity`.

## D09 — Merchant writes could outlive failed audit persistence

**P1 · Fixed** · `src/modules/merchants/internal/transport/merchant/dashboard.functions.ts:171`

Create/edit/archive committed before audit insertion. Real PostgreSQL fault injection reproduced all three partial writes. Each mutation and its audit now share a transaction; edit row lock spans the update.

Evidence: `merchant-authorization-baseline; complete-authorization-integration`.

## D10 — Missing migration checksums silently fabricated history

**P1 · Fixed** · `scripts/migrate.mjs:82`

Migrator stamped current checksums on historical rows with no proof. It now refuses unknown history and requests evidence-based reconciliation. No migration was edited or deleted.

Evidence: `migration-missing-checksum-reproduction; migration-missing-checksum-fixed; migration-normal-history-preserved`.

## D11 — Premature authentication navigation

**P2 · Fixed** · `src/routes/provider/login.tsx:17`

Better Auth callbackURL redirected before application-specific follow-up and routing. Removed redundant sign-in redirects across affected forms, retaining TOTP redirects. Provider password form now agrees with minimum length.

Evidence: `provider-signup-browser; provider-signup-browser-fixed; merchant-workspace-recovery-fixed`.

## D12 — Unavailable SMS stranded merchant onboarding

**P2 · Fixed** · `src/routes/merchant/register.tsx:62`

Application was saved but UI stayed on consumed email verification after SMS failure. Added honest pending-phone state, retry, status link and disabled verification without a challenge.

Evidence: `merchant-onboarding-before-fix; origin-merchant-browser`.

## D13 — Rejected merchant forms erased input

**P2 · Fixed** · `src/routes/merchant/dashboard.tsx:108`

Action wrapper handled rejection but resolved its promise; unconditional then reset/close erased create/edit input. Removed those post-action handlers; successful writes already reload.

Evidence: `merchant-workspace-baseline-corrected; merchant-workspace-recovery-fixed`.

## D14 — Scheduler could not reach host-isolated workers

**P1 · Fixed** · `scripts/scheduler-request.mjs:10`

Private-network requests lacked configured Host and worker limits expected public forwarded identity. Requests now preserve configured Host with node:http and signed internal subject limits. HMAC/replay checks retained.

Evidence: `scheduler-private-ingress-before-fix; scheduler-live-after-fix`.

## D15 — Scheduler idle ticks misreported health

**P2 · Fixed** · `scripts/scheduler-heartbeat.mjs:3`

Five-minute beta cadence conflicted with per-minute health expectations; idle ticks erased failed work. Separate loop freshness and last completed run, preserving failures until successful work.

Evidence: `scheduler-idle-health-baseline; scheduler-heartbeat-fixed; compose-start-mount-repaired`.

## D16 — Idle database/cache connections retained shutdown

**P2 · Fixed** · `src/lib/security/redis-rate-limit.server.ts:145`

Idle Redis socket and PostgreSQL pools held the event loop after HTTP shutdown. Unref idle socket and allow idle pools to exit; pending work remains awaited.

Evidence: `redis-process-exit-before-fix; redis-process-exit-after-fix; graceful-shutdown-after-fix`.

## D17 — Optional push blocked beta builds

**P2 · Fixed** · `scripts/validate-push-client-env.mjs:14`

Shared beta build demanded a push provider despite optional notifications. Permit both settings absent only for explicit beta/local; hide unavailable push UI and still reject mismatches.

Evidence: `beta-production-build failure; unit-tests-with-build-gate; final-csp-production-build`.

## D18 — Compose start sequencing did not prove readiness

**P2 · Fixed** · `compose.yaml:13`

Added app and authenticated cache health, dependency readiness, scheduler grace and least-privilege app capabilities; limited scheduler secrets.

Evidence: `compose-network-tls-isolation; final-csp-image-tls-health`.

## D19 — SSR errors erased the access-denied page

**P1 · Fixed** · `src/start.ts:22`

Loader-error response lost nonce-bearing CSP headers. Browser blocked inline router bootstrap and replaced SSR message with blank content. Apply security headers to final response, preserving request nonce and response status.

Evidence: `provider-workspace-browser failure; final-csp-unit; provider-workspace-csp-fixed`.

## D20 — Referenced discovery browser suite missing

**P2 · Fixed** · `tests/discovery-browser.e2e.mjs:1`

Restored advertised browser command with actual search/cart/mobile/API-boundary checks.

Evidence: `discovery-browser-selector-fixed`.

## D21 — Executive moderation dashboard crashes on database dates

**P1 · Fixed** · `src/modules/administration/internal/transport/admin/moderation.functions.ts:23`

Customer/product timestamps were returned as PostgreSQL Date objects despite declared string types. React rejected them, preventing the authenticated executive dashboard from rendering. Real PostgreSQL regression reproduced the mismatch. Both projections now format UTC text without changing authorization or database schema.

Evidence: `executive-browser-after-rate-window`, `moderation-date-baseline`, `moderation-date-fixed`, final executive browser.

## D22 — Long audit IDs overflow the executive mobile dashboard

**P2 · Fixed** · `src/routes/admin/dashboard.tsx:350`

Implicit mobile grid tracks expanded to the minimum width of unbroken audit identifiers. Explicit grid-cols-1 and wrapping preserve readable content within the viewport. Actual browser geometry reproduced the overflow and verified the correction.

Evidence: `executive-browser-navigation-stable`, final executive browser.

## R01 — Mobile dependency security gate fails

**P1 · Open** · `mobile/package-lock.json:3629`

35 affected packages:21high/14moderate, propagated from five advisory causes. Latest braces3.0.3 and node-forge1.4.0 still vulnerable. Nonbreaking audit fix did not resolve; no forced unsupported SDK change.

Evidence: `mobile-dependency-audit; registry inspection2026-10-14`.

## R02 — Existing database upgrade provenance unavailable

**P1 · Unverified history** · `migrations.sha256.json:41`

186 current migrations pass fresh/repeat/restore checks. Number0034 is absent and source history says0041/0105 were rewritten before this audit. No original artifacts provided; unknown upgrades cannot be certified.

Evidence: `postgres-fresh-migration; migration-normal-history-preserved`.

## R03 — Total executive factor-loss recovery not verified

**P2 · Open** · `docs/deployment.md:65`

Unused TOTP recovery codes work and cannot be replayed. Loss of authenticator plus every recovery code lacks a verified audited recovery flow. No bypass introduced.

Evidence: `executive-recovery-configured`.

## R04 — Face matching and spoof resistance unverified

**P1 · Disabled** · `src/modules/identity/internal/auth/executive/engine.server.mjs:22`

Experimental protocol/PAD tests do not validate real matching, liveness, camera or spoof resistance. Face login stays disabled in shared environments and device-independent in architecture.

Evidence: `pad-contract-tests; executive-workspace-browser API assertions`.

