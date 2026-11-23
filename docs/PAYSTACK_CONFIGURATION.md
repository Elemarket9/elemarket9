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

## Docker Compose deployment

Run these commands from the project folder using CMD. On first setup only,
create the private environment file (do not overwrite an existing one):

```cmd
copy .env.example .env.production
```

Fill in the real domains, database/Redis credentials, application secrets,
mandatory delivery OTP configuration, and payment variables in that file.
Keep `ELEMARKET_PUBLIC_URL` empty to use `BETTER_AUTH_URL`, or set both to
the same HTTPS marketplace origin. The environment example contains empty
required credentials and example domains; it is not deployable unchanged.

Build and start the stack:

```cmd
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=100 app
```

The app service already declares `env_file: .env.production`, so payment
driver variables and secrets reach the server at runtime. The Docker build
excludes private environment files; payment secrets are not build arguments.
The container runs `scripts/start.mjs`, which validates the environment and
automatically applies pending migrations, including 0211, before starting
the server. A separate host-side `npm run db:migrate` is unnecessary for this
Compose deployment. A failed validation or migration prevents server startup;
inspect the app logs before continuing.

After changing only environment variables, recreate the app container:

```cmd
docker compose --env-file .env.production up -d --force-recreate app
```

Restarting a container alone does not refresh its environment. Updating the
application code or bundled payment driver requires `up -d --build` again.
The payment readiness and registry activation requirements above still apply.

## Zero-commission orders (`ELEMARKET_PAYSTACK_EXPLICIT_ZERO_SPLIT`)

When ELEMARKET's commission on an order is GH₵ 0 (a 0% category, a 100%-off
merchant coupon, or a fee that rounds to nothing), Paystack is sent the
merchant subaccount with no `transaction_charge`. Paystack then splits the
payment using the **percentage set on that subaccount in the Paystack
dashboard**. If that percentage is not 0, ELEMARKET takes a share it is not
owed and the merchant receives less than the ledger records.

Until the setting below is switched on, every merchant subaccount must have
**percentage charge = 0** on the Paystack dashboard.

Set `ELEMARKET_PAYSTACK_EXPLICIT_ZERO_SPLIT=1` to send these orders as an
explicit flat split instead: the full amount goes to the merchant's subaccount,
with ELEMARKET's main account bearing the Paystack fee. This is the same split
format the group checkout uses. Verify it in the Paystack **test** environment
first (one zero-commission card payment and one mobile money payment), then
enable it in production. Orders that carry commission are not affected.

## Stuck refunds

Refunds whose outcome is unknown (a timeout, a crash, or a `refund.failed`
webhook) are looked up on Paystack by the refund recovery job (`GET /refund/:id`,
or the transaction's refund list). An existing refund is adopted, never
duplicated. A new refund is sent only when Paystack shows none, or only failed
ones, for that payment, and the first attempt is at least 10 minutes old.
