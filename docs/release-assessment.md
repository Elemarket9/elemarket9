# ELEMARKET public-release source assessment

Updated 2026-10-15. The application has no Developer Beta launch profile or
restricted worker subset. Public use is supported by the normal deployment
configuration, real authentication, and independently configured providers.
This document is an evidence report, not a runtime access switch.

## Restrictions removed

- The auth-off switch no longer substitutes a shared developer identity. Browser
  and server resolve real sessions in every environment; the obsolete flag is ignored.
- Preview payment bootstrap is off by default and cannot reactivate an inactive
  provider. Explicit isolated development use requires ELEMARKET_ENABLE_PREVIEW_COMMERCE=1.
- Delivery has no automatic preview fallback. A configured, active adapter provides quotes.
- Public portal links derive from configured hostnames or explicit public origins,
  rather than guessing fixed subdomains. Only public origins enter the browser bundle.
- Additive migration 0188 archives unclaimed historical sample inventory, with
  complete row snapshots. It preserves shops with ownership, orders, renamed
  identities or additional products. Historical migrations are unchanged.
- Beta-only terms wording and stale release metadata are replaced with current status.
- The fixed local analytics signing secret is replaced with a per-process random
  development key. Shared deployments still require the configured secret.

## Public deployment

Use Node 22, durable PostgreSQL, HTTPS and the trusted proxy configuration in
.env.example and compose.yaml. Supply actual domains, the provisioned executive
user ID, fresh secrets and credentials for the services you intend to offer.
Run migrations through the normal checksum-verified startup gate. Provision and
verify real merchant accounts and activate real provider records. An empty new
catalog is intentional; publish approved inventory through the existing workflows.

Missing credentials cannot be replaced by successful-looking responses. Email
and SMS delivery, storage, delivery quotes, payments, financing handoff/API access
and push must be exercised against the chosen provider before advertising them.
The empty financing API registry needs a real provider adapter; supported manual
review and partner handoff do not require that API integration. Unverified
biometric authentication stays off; password authentication and TOTP remain.

## Verification boundaries

Local source checks, advisory regressions and builds are recorded in
verification.md and ci-repair.md. Mobile includes maintained source security
forks; registry audit results do not assess those forks. Native device testing,
public infrastructure, real-provider end-to-end tests, operational capacity,
backup recovery for the actual host and the remote GitHub rerun are separate
unverified deployment work. No public deployment or whole-system certification
is claimed by removing artificial development restrictions.

The original assessment is retained under history/ as dated evidence.
