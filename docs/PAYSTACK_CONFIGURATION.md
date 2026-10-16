# Paystack configuration

The bundled adapter is selected through environment configuration and the database
registry. Marketplace checkout rules do not select a vendor by name.

Copy the payment variables from `.env.example` into your hosting platform's
server environment, or `.env.production` for Compose. Compose already passes
that file into the app. A Compose `--env-file` alone does not replace the app's
`env_file: .env.production`. Local CLI commands need variables exported in their
environment; the migration script does not automatically load `.env` files.

Set `ELEMARKET_PAYMENT_DRIVER_PAYSTACK_MODULE=builtin:paystack` and include
`builtin:paystack` in the comma-separated `ELEMARKET_PAYMENT_ALLOWED_MODULES`.
The literal bundled import works in the production build; a TypeScript source
path is not a runtime module path.

With the intended database's `DATABASE_URL` supplied, run `npm run db:migrate`.
Migration 0211 assigns driver `paystack` to these existing rows:

| Provider key | Method | Environment prefix |
| --- | --- | --- |
| `paystack` | mobile money | `ELEMARKET_PAYMENT_PAYSTACK` |
| `paystack-card` | card | `ELEMARKET_PAYMENT_PAYSTACK_CARD` |
| `paystack-bank-transfer` | bank transfer | `ELEMARKET_PAYMENT_PAYSTACK_BANK_TRANSFER` |

For each method you intend to use, set its `_SECRET` to your account's secret
key and `_CHECKOUT_HOSTS` to the verified checkout hostnames (no scheme or path).
The `_DRIVER=paystack` variables also support adapter callers without a registry
driver argument; database rows supply the driver during normal checkout.
Keep secrets server-side, without a `VITE_` prefix. Use test credentials for UAT.
The callback origin comes from `ELEMARKET_PUBLIC_URL` or `BETTER_AUTH_URL` and
must match the canonical marketplace origin in shared deployments.

This migration preserves provider statuses and merchant subaccount requirements.
It does not activate providers, provision merchant subaccounts, or configure
the Paystack dashboard. No live database was changed by editing these files.

New checkout remains blocked because the adapter currently declares
`supportsIdempotentInitialization = false`. The existing readiness check requires
verified safe retry/recovery behavior before accepting new charges. Do not flip
that flag merely to enable checkout. Complete initialization timeout/recovery
implementation and tests, signed webhook/transaction verification tests, merchant
subaccount setup, and method availability checks before activating registry rows.
Bank transfer availability must be confirmed for the account and GHS market.
