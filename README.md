# ELEMARKET â€” Modular Marketplace Application

Provider-neutral marketplace platform for commerce, payment-provider settlement/refunds, financing and delivery orchestration. ELEMARKET does not custody customer funds.

## Core

- Product catalogue, variants, cart, checkout and orders
- Merchant, verified-brand and enterprise boundaries
- Provider-neutral payment architecture with deployment-selected adapters
- Provider-managed settlement, refunds and reconciliation controls
- Provider-neutral financing/BNPL integration
- Delivery/logistics adapter boundary
- Authentication, authorization and object-ownership enforcement
- Rate limiting, security headers, startup validation and observability
- PostgreSQL migrations and concurrency-integrity tests

## Payment architecture

The marketplace core does not select or depend on a named payment vendor. Provider adapters are isolated from the core and selected through server-side deployment configuration.

Never expose provider driver module configuration or provider credentials to clients.

## Development

Use Node.js 22.x. The local preview uses PGlite with its pgcrypto extension; shared deployments require PostgreSQL.

```bash
npm ci
npm run check:architecture
npm run typecheck
npm run lint
npm test
npm run build
```

PostgreSQL-backed integration verification:

```bash
# Use a disposable PostgreSQL database; tests retain synthetic financial evidence.
export ELEMARKET_INTEGRATION_DATABASE_URL="postgresql://.../elemarket_test"
DATABASE_URL="$ELEMARKET_INTEGRATION_DATABASE_URL" npm run db:migrate
RUN_DB_INTEGRATION=1 npm run test:integration:concurrency
```

The regression suite covers money conversion, IPv6 endpoint filtering, webhook parsing, homepage settings, and the complete PGlite migration chain. PostgreSQL tests cover checkout/stock idempotency, discounts, payment replay, late-payment reconciliation, ownership, and concurrent provider-owner changes. CI runs both suites.

## Production boundary

Real payment, financing and delivery providers must be configured and contract-tested before production use. Regulated custody, credit decisions, KYC/KYB and other regulated functions remain with appropriately licensed providers unless ELEMARKET separately obtains the required authorization.

## Scope

Education AI is intentionally outside this repository and will be developed as a separate project.

### Authentication email adapter

Authentication email (password reset and email verification) and email OTP use the same provider-neutral server-side email adapter. The default production provider is Resend.

## Resend email OTP

The application supports provider-neutral email OTP through the Resend adapter. Configure these server-only variables in the deployment environment:

- `ELEMARKET_EMAIL_PROVIDER=resend`
- `RESEND_API_KEY=<sending-scoped Resend API key>`
- `RESEND_FROM_EMAIL=ELEMARKET <no-reply@your-verified-domain>`
- `RESEND_REPLY_TO=<optional reply address>`
- `RESEND_WEBHOOK_SECRET=<Resend Svix webhook signing secret>`

The API key and webhook signing secret must never be exposed to client-side code. Configure the Resend webhook endpoint as `/api/email/webhook` and subscribe to the email events required for operations. Use a Resend sending-scoped key restricted to the verified sending domain where possible. Resend supports sending-scoped API keys and domain restrictions. The adapter uses Resend's Email API over HTTPS and an idempotency key per OTP challenge.

### Push notifications (FCM)
ELEMARKET uses Firebase Cloud Messaging through a server-side adapter. Keep the Firebase service-account JSON only in the server secret store; never expose it through `VITE_*` variables or the browser bundle.

- `ELEMARKET_PUSH_PROVIDER=fcm`
- `FCM_SERVICE_ACCOUNT_JSON=<Firebase service-account JSON>`

Mobile clients register their FCM token through the authenticated push-token server functions. The database stores the token server-side and binds it to the authenticated account.

## FCM web push configuration

The server uses `FCM_SERVICE_ACCOUNT_JSON` for Firebase HTTP v1 sending. The browser uses Firebase public configuration values; these are client identifiers, not service-account secrets. Configure:

```text
FCM_SERVICE_ACCOUNT_JSON=<server-only Firebase service account JSON>
VITE_FIREBASE_API_KEY=<Firebase web API key>
VITE_FIREBASE_AUTH_DOMAIN=<Firebase auth domain>
VITE_FIREBASE_PROJECT_ID=<Firebase project id>
VITE_FIREBASE_STORAGE_BUCKET=<Firebase storage bucket>
VITE_FIREBASE_MESSAGING_SENDER_ID=<Firebase messaging sender id>
VITE_FIREBASE_APP_ID=<Firebase web app id>
VITE_FIREBASE_VAPID_KEY=<Firebase Web Push certificate public key>
```

Push registration is authenticated and the FCM token is registered through the notifications module. Never expose `FCM_SERVICE_ACCOUNT_JSON` or a Firebase private key through a `VITE_` variable.

### Merchant KYB (Fylings adapter)
Merchant onboarding uses a provider-neutral KYB interface. Fylings is the current adapter and can be replaced without changing merchant-domain code.

Server-only deployment variables:

- `FYLINGS_API_KEY=<server-only Fylings API key>`
- `FYLINGS_BASE_URL=https://www.fylings.com` (optional; HTTPS required)

The merchant application can submit an optional business registration number. ELEMARKET sends the business name and registration number (when supplied) with country `GH` to Fylings. Fylings returns `verified`, `review`, or `not_found`; ELEMARKET stores a normalized verification result and evidence for admin review. A Fylings result is not itself the final merchant approval: an ELEMARKET administrator must approve the merchant application after email, phone, and business checks are satisfied.

## Location / Geocoding

ELEMARKET uses a provider-neutral `LocationProvider` with Geoapify as the current implementation. Configure `ELEMARKET_LOCATION_PROVIDER=geoapify` and `GEOAPIFY_API_KEY` on the server/Render environment. The API key must never be exposed to browser code. Address lookups are Ghana-filtered and cached for 30 days to reduce free-tier usage. The checkout UI includes Geoapify/OpenStreetMap attribution required for the free plan.

## Enterprise catalog + provider settlement

Enterprise merchants can be switched on by an authorized admin. Enterprise mode sets:

- `tier=enterprise`
- `settlement_model=enterprise_direct`
- `catalog_source=enterprise_api`

Enterprise products are synchronized from the merchant's own HTTPS catalogue API. The connector supports bearer token, API-key, basic authentication, field mapping, upsert-only/snapshot sync, encrypted server-side credentials, sync history, and an optional HMAC webhook trigger.

Enterprise orders remain visible in ELEMARKET's order/payment/audit systems, and the configured payment provider can route the payment to the merchant's provider subaccount. **All orders use provider-managed settlement. ELEMARKET does not custody, release, settle, or pay out customer funds. Refunds are initiated through the configured payment provider and finalized from provider webhooks.**

Required deployment secret for the protected scheduled sync endpoint:

`ELEMARKET_ENTERPRISE_SYNC_SECRET`

The scheduled endpoint is `POST /api/enterprise/catalog/sync` with the `x-elemarket-sync-secret` header. Enterprise catalog credentials require the existing `ELEMARKET_MERCHANT_DATA_ENCRYPTION_KEY` encryption key.

The brand/distributor worker endpoint (`POST /api/internal/brand-integration-worker`) requires an HMAC proof using `ELEMARKET_ENTERPRISE_SYNC_SECRET` (or `CRON_SECRET` when the enterprise secret is unset). Use the timestamp, nonce and body-bound signing protocol described under Scheduled workers below; this route does not accept bearer authentication.

## Scheduled workers

The four GET routes listed in `vercel.json` accept Vercel's
`Authorization: Bearer <CRON_SECRET>` header. Set a strong random `CRON_SECRET`
in the Vercel project's deployment environment. Enterprise worker HMAC secrets
remain separate: `ELEMARKET_ENTERPRISE_SYNC_SECRET` does not replace the bearer
credential. Bearer authentication is limited to those scheduled GET routes;
POST workers and other internal routes still require a signed HMAC request.

An external scheduler (including a Render deployment) must call these GET
routes with the same bearer credential or generate the existing HMAC proof.
The HMAC message is
`<timestamp>.<nonce>.<METHOD>.<pathname>.<sha256(body)>`, with the timestamp,
nonce, and signature sent in `x-elemarket-sync-timestamp`,
`x-elemarket-sync-nonce`, and `x-elemarket-sync-signature`. Nonces prevent signed
request replay. The order-outbox and webhook workers use the enterprise sync
secret when configured; the other scheduled jobs use `CRON_SECRET`.

Monitor scheduled-job responses and queue progress after deployment. Never put
scheduler credentials in URLs or source control. See
[Vercel's cron authentication documentation](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

## Modular monolith

Business capabilities live under `src/modules`, with separate `public` entry points and `internal` implementations. Cross-module imports use public contracts; the architecture check rejects private imports and dependency cycles. Routes contain UI and HTTP transport, while server-function business operations live in their owning modules. Payment/financing integration is wired through `src/application/payment-webhook.server.ts`.

See [module ownership and service extraction](docs/MODULAR_MONOLITH.md) and [local verification and audit](docs/MODULAR_MONOLITH_VERIFICATION.md).

## Frontend and support verification

Customer chat and admin support share account/conversation-scoped implementations, polling and safe retry behavior. See [the frontend and support audit](docs/FRONTEND_SUPPORT_AUDIT.md) for fixes, local results and the repeatable `npm run test:frontend` browser suite. Test fixtures and screenshots belong outside the project directory.


## EIDE v1 â€” ELEMARKET Intelligence & Discovery Engine

EIDE is the marketplace-owned, provider-neutral intelligence layer. It never controls payment, order, refund, authorization, or settlement state. Relevance ranking uses authoritative PostgreSQL candidate retrieval and bounded mathematical reranking from merchant confidence, Bayesian conversion quality, saturating popularity, trend momentum, freshness decay, inventory health, and capped UCB-style exploration. Behavioral signals cannot rescue an irrelevant result.

EIDE also computes product SEO quality and indexability from genuine catalog completeness, inventory, freshness, and merchant confidence. Thin/weak pages are marked `noindex`; qualifying pages remain indexable and expose canonical/product metadata. Raw customer search text is not retained: search observations use a keyed digest. Product funnel events remain privacy-minimized.

Feature refreshes rotate through the catalog via the existing enterprise-catalog scheduler (`refresh_eide_features(500)`), avoiding a new cloud dependency. The mathematical invariants can be checked with `npm run test:eide`.


## EIDE v3 â€” adversarial hardening

EIDE v3 removes anonymous traffic from negative conversion-quality judgments, adds trusted-commerce evidence to live search ranking, caps untrusted popularity influence, confidence-shrinks trend signals, preserves evergreen SEO eligibility, bounds funnel-event retention, and adds a canonical product `updated_at` compatibility column/trigger. Search relevance remains a multiplicative gate: commerce evidence cannot rescue an irrelevant result.

## EIDE v4 â€” aggressive scale and SEO hardening

EIDE v4 introduces a trusted-change dirty queue so catalog and order-state changes are refreshed ahead of background rotation without allowing anonymous funnel traffic to trigger expensive feature recomputation. Null/expired feature TTLs now fail closed for behavioral ranking signals. Search facet expansion is bounded to the strongest 5,000 matching candidates to prevent unbounded JSON attribute expansion. Public discovery now includes an EIDE-governed `/sitemap.xml` containing only currently index-approved, active, in-stock products from verified active merchants, plus `/robots.txt` advertising that sitemap and excluding private workflow surfaces.


## Recovery patch (2026-10-13)

The shared launch profile is `marketplace`. Select implemented and registered
email, OTP, storage, location, and push adapters through the corresponding
`ELEMARKET_*_PROVIDER` environment keys. The provider capability registry
(`config/provider-capabilities.json`) supplies the adapter-specific required
credentials; none of these vendor choices is a marketplace-domain policy.
`ELEMARKET_KYB_PROVIDER` is optional where the manual review process is enabled.
Startup validation checks configuration requirements but does not replace a
runtime adapter, sandbox, or partner contract test. For browser push, the
`VITE_ELEMARKET_PUSH_PROVIDER` build selection must match the server selection
and satisfy `clientRequiredEnv` for the selected adapter. Set `ELEMARKET_TRUST_PROXY=1` and
`ELEMARKET_PROXY_OVERWRITES_FORWARDED_FOR=1` only behind a proxy that actually
overwrites forwarded client-IP headers. Set `ELEMARKET_LAUNCH_PAYMENT_PROVIDERS`
to a comma-separated list of enabled provider keys and configure each driver's
credentials, endpoint or allowlisted module. Configure the real delivery quote
provider and an active production `delivery_providers` row with the same key.

Paid orders create an outbox entry in the order transaction. The scheduled
`/api/internal/dispatch-deliveries` worker creates one provider-bound job per
order for the existing partner portal. Failed local assignment retries with
backoff and stops at eight attempts for review. Admins can invoke
`assignOrderDelivery` to retry manual assignment against the purchased quote.
Direct carrier API booking remains unimplemented pending authorization of a
specific carrier endpoint and delivery data payload; no automatic outbound
carrier booking was added.

Uncertain refund attempts require `reconcileRefund` on the adapter. Creation
retries additionally require `supportsIdempotentRefunds=true`, backed by a
verified provider contract and concurrency tests. The bundled Paystack adapter
does not claim refund idempotency and does not implement lookup reconciliation;
its uncertain attempts remain `needs_attention` until a verified webhook or
operator/provider investigation confirms the result. The bundled payment adapter
also does **not** assert retry-safe checkout initialization and will fail closed
until a tested initialization/recovery protocol is available; do not use it for
live checkout until this release blocker is addressed. Leases allow a capable
adapter to recover execution; no blind refund retry is allowed.

Migrations 0041 and 0105 were rewritten with user authorization. They are not
restored historical originals. Their manifest checksums were intentionally
updated. Fresh installation was replayed successfully in local PostgreSQL WASM.
An existing database recording the original checksums will fail the unchanged
checksum-drift gate. Reconcile such databases using reviewed schema evidence,
backups, and an explicitly approved forward migration; do not blindly overwrite
`_migrations` checksums. No production database was modified.


## Subdomain portal separation (optional, opt-in)

See [`infra/PORTAL_SUBDOMAINS.md`](infra/PORTAL_SUBDOMAINS.md). This build adds testable executive/staff/customer/seller/provider host segregation and dedicated local `.test` vhosts without claiming biometric authentication or developer-beta release readiness.

### Subdomain remediation (13 October 2026)

The five-host source and controlled `developer_beta` launch profile are documented in [`infra/PORTAL_SUBDOMAINS.md`](infra/PORTAL_SUBDOMAINS.md) and [`infra/BETA_RELEASE_GATES.md`](infra/BETA_RELEASE_GATES.md). `compose.yaml` defaults to the non-money-moving beta profile; real transactional features remain blocked. Run `node --test tests/*.test.mjs` in the developer package. **Not production-certified:** Docker, full build, browser login/2FA, migration-on-PostgreSQL and independent frontend bundle separation require further verification. Facial recognition + alphanumeric PIN has deliberately not been implemented.

## Optional open-source executive face matching adapter (not live authentication)

The CompreFace REST API recognition adapter and private signed engine/PAD bridge live in `integrations/executive-face/` and are described in `infra/COMPREFACE_EXECUTIVE_INTEGRATION.md`. This integration does not install/run CompreFace or complete qualified liveness validation. Main Admin face login **stays disabled**; existing password + TOTP remains active until a validated presentation-attack-detection service, privacy controls and real end-to-end tests are completed.


### Executive authentication update (13 October 2026)

The executive portal now offers an explicit choice of **Face + Alphanumeric Passphrase** or **Better Auth password + TOTP**. The face/PIN workflow no longer requires registering any phone, browser or hardware key; the former IndexedDB signing-key flow is retired. Face/PIN is **still disabled in production** pending independent security testing. See `infra/EXECUTIVE_DEVICE_INDEPENDENT_2026-10-13.md`.
