# Merchant wallet

The merchant wallet shows each merchant what they have sold, what is withheld,
what is available to withdraw, what is being paid out and what has been paid,
and it sends payout commands to whichever payout provider ELEMARKET connects.

## Custody boundary

Customer money is held by the connected payment provider, and payouts are
made by the connected payout provider. ELEMARKET is neither a custodian nor a
disbursement institution: it never holds or moves funds itself. The wallet is
a ledger of what each merchant is owed, plus the instructions it sends the
provider to pay them.

## Who uses it

Wallet settlement is opt-in per merchant (`merchants.settlement_model`):

| Mode | How the merchant is paid |
| --- | --- |
| `provider_direct` (default) | The checkout charge is split to the merchant's provider sub-account. The wallet shows nothing. |
| `platform_wallet` | The charge stays in the platform's provider account. The wallet credits, releases and pays out. |

An admin moves a merchant with **Move to wallet payouts** on the admin dashboard
(`wallet_enable_for_merchant`, capability `admin.finance.policy`). It is refused
while the merchant has unpaid checkouts, because those were started with the
split. Earlier orders are never backfilled: the provider already paid them, and
crediting them again would pay the merchant twice.
Each charge is stamped with how it was set up the first time it is
initialized, and that stamp cannot change, so a split charge that completes
late is never credited, and a wallet charge is still credited if the
merchant's mode changes afterwards.

## Balances

Every movement is an append-only row in `wallet_ledger_entries`. A balance is
the sum of a bucket, and every cedi sits in exactly one bucket.

| Event | Movement |
| --- | --- |
| Payment completed | + merchant share (`orders.merchant_net`: products minus commission; delivery is not merchant revenue) to **withheld**, only for charges stamped `payments.settlement_model = 'platform_wallet'` when first initialized |
| Release | withheld → **available** once the customer confirmed delivery by rider OTP, the longest return window that could still apply has closed (the product's window, and at least the 7-day faulty-item guarantee; never under 24 hours), and there is no open dispute, return or refund |
| Refund processed | − merchant's proportional share: from withheld first, then available, and any remainder is recorded as **owed** (recovery). Available never goes negative. |
| Release | repays anything owed first, then the rest becomes available |
| Withdrawal requested | available → **processing** (reserved) |
| Payout paid | processing → **paid out** (net) + **transfer fees** |
| Payout failed or cancelled | processing → available |
| Provider pays a payout recorded as failed | available (then owed) → paid out + fees, and a critical exception |

PostgreSQL checks these invariants at the end of every transaction that writes
the ledger: no bucket below zero, nothing owed above zero, and every movement
between buckets nets to zero. A violating transaction is rolled back.

The merchant pays the transfer fee: it is deducted from the amount withdrawn.
One withdrawal can be in progress per merchant. Only the merchant owner can
withdraw, cancel an unsent withdrawal, or add payout accounts, after a fresh
sign-in; admins can only view.

### Limits and payout accounts

Configurable, enforced inside PostgreSQL under the merchant's lock:
`ELEMARKET_WALLET_MIN_WITHDRAWAL` (default 5), `ELEMARKET_WALLET_MAX_WITHDRAWAL`
(50 000), `ELEMARKET_WALLET_DAILY_WITHDRAWAL_AMOUNT` (100 000) and
`ELEMARKET_WALLET_DAILY_WITHDRAWAL_COUNT` (5) per 24 hours.

A new payout account can receive money only after
`ELEMARKET_WALLET_DESTINATION_COOLDOWN_HOURS` (default 24). An account's
destination never changes in place (database-enforced); a different destination
is a new account with its own cooling period. Each withdrawal stores the
destination authorized when it was requested, and every attempt pays that one.

## Withdrawal states

| State | Merchant sees | Meaning |
| --- | --- | --- |
| `requested` | Reserved | Funds reserved; nothing sent yet. The merchant can cancel. |
| `submitting` | Processing | A send is recorded and may be in flight. |
| `processing` | Processing | The provider accepted it. |
| `uncertain` | Under review | The outcome of a send is unknown (timeout, crash). |
| `needs_attention` | Under review | Quarantined for reconciliation by staff. |
| `paid` / `failed` / `cancelled` | Completed / Failed / Cancelled | Final. Never re-run, never reversed silently. |

How the wallet decides (`src/modules/wallet/internal/wallet.server.ts`):

1. Every send is written to `wallet_payout_attempts` **before** the provider is
   called. A crash therefore leaves proof that money may have moved.
2. A timeout or unknown error makes the payout **uncertain**, never failed. Its
   reservation stays.
3. An uncertain payout is **read back** first. It is re-sent (same
   idempotency key) only if the provider has no record **and** declares
   idempotent initiation. Otherwise it is quarantined. A provider without status
   lookup is quarantined at once.
4. Reserved funds return to available only when the provider reports the
   transfer failed or refused it outright (HTTP 400/422).
5. Workers coordinate through row locks and leases in PostgreSQL, on any number
   of instances. No provider call runs inside a database transaction.

## Reconciliation

Every run of `/api/internal/wallet-settlement` releases matured funds, sends
reserved withdrawals, recovers uncertain ones, reads back accepted ones, and
re-checks payouts settled in the last 7 days so a provider reversal or late
success is never missed. Every 15 minutes it also compares the provider's own
transfer list (when the provider supports listing) with the wallet.

Differences are recorded in `wallet_reconciliation_exceptions` (duplicate
external payout, unknown external payout, amount or currency mismatch, missing at
provider, late success after failure, failure after success, unverifiable
outcome). Balances are never forced to match: staff resolve each exception with a
written resolution (`wallet_resolve_exception`). `wallet_reconciliation_summary()`
reports collections, commissions, entitlements, buckets, payouts by state, open
exceptions and invariant violations.

Staff can resolve only `needs_attention` or `uncertain` withdrawals, with written
evidence of the provider outcome (`wallet_admin_resolve_payout`: paid, failed, or
requeue, which forces a read-back before any resend). A paid, failed or cancelled
withdrawal can never be retried or re-decided by staff. Every action is audited.

## Connecting a payout provider

Set `ELEMARKET_PAYOUT_DRIVER`. Payouts already in flight keep the driver they
were created with, so you can switch providers at any time.

### `signed-http` (any provider)

Point `ELEMARKET_PAYOUT_HTTP_ENDPOINT` at a provider that implements the
contract below, or at a small bridge service that translates it to the
provider's own API. Share `ELEMARKET_PAYOUT_HTTP_SECRET` (32+ characters) with it.

Every request from ELEMARKET carries:

```
x-elemarket-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<METHOD>.<path>.<raw body>")>
idempotency-key: <payoutId>            (payout creation only)
```

Reject requests whose timestamp is more than 5 minutes off.

| Call | Body | Response |
| --- | --- | --- |
| `POST {endpoint}/destinations` | `{rail: "mobile_money"\|"bank", accountNumber, institutionCode, accountName}` | `{destinationRef, resolvedAccountName?, verified}` |
| `POST {endpoint}/payouts` | `{payoutId, amount: "98.50", currency: "GHS", rail, destinationRef, narration}` | `{providerReference, status: "processing"\|"paid"\|"failed", amount?, currency?, failureReason?}` |
| `GET {endpoint}/payouts/{payoutId}` | — | same as above, or `404` if unknown |
| `POST {endpoint}/fees` (only with `ELEMARKET_PAYOUT_HTTP_REMOTE_FEES=1`) | `{amount, currency, rail}` | `{fee: "1.00"}` |
| `GET {endpoint}/payouts?since=<ISO time>` (only with `ELEMARKET_PAYOUT_HTTP_LISTING=1`) | — | `[{payoutId, providerReference, status, amount, currency}]`, every transfer since then |

Rules for the provider side:

- **Idempotency is mandatory.** A repeated `POST /payouts` with the same
  `idempotency-key` must return the original transfer (or `409`, after which
  ELEMARKET reads it back). It must never send money twice.
- Return `400` or `422` only when the transfer was definitely **not** created;
  ELEMARKET then returns the money to the merchant's available balance. Any
  other error is treated as "may have been sent" and retried with the same key.
- `amount` is what the merchant receives (the fee is already deducted).
- Only `destinationRef` (an opaque token) and the last 4 digits are stored by
  ELEMARKET. Raw account numbers pass through once and are not kept.

Status notifications go to `POST /api/payouts/webhook` with body
`{"payoutId": "...", "providerReference": "..."}`, signed as
`x-elemarket-signature: t=<t>,v1=<HMAC-SHA256(secret, "<t>.<raw body>")>`. The
notification only tells ELEMARKET which payout to check: the final status is
always read back with `GET /payouts/{payoutId}`, so a forged or replayed
notification cannot mark anything paid.

### Vendor-specific driver modules

Every driver declares its capabilities, and the wallet bases every retry and
recovery decision on them. Anything not declared exactly `true` counts as
unsupported:

| Capability | Meaning | Without it |
| --- | --- | --- |
| `idempotentInitiation` | Repeating a send with the same key never pays twice | An unconfirmed send is quarantined, never repeated |
| `statusLookup` | `getPayout` returns the authoritative state | Uncertain sends are quarantined; final status comes from signed webhooks |
| `webhooks` | Authenticated notifications | Status comes from read-back |
| `reconciliationListing` | `listPayouts` returns the provider's transfers | No external duplicate detection for that provider |
| `destinationValidation` | The provider confirms accounts exist | New accounts stay pending (not withdrawable) |
| `feeQuote` | The provider quotes transfer fees | Configured fees are used |

To talk to a provider's API directly, add a module to
`src/modules/wallet/internal/adapters/providers/` that exports
`createPayoutDriver({ key })` implementing `PayoutDriver`
(`src/modules/wallet/public/adapters/payout.ts`), register it in that folder's
`registry.ts`, then configure:

```
ELEMARKET_PAYOUT_DRIVER=<name>
ELEMARKET_PAYOUT_DRIVER_<NAME>_MODULE=builtin:<name>
ELEMARKET_PAYOUT_ALLOWED_MODULES=builtin:<name>
```

Vendor names must stay inside that folder; `npm run check:architecture`
enforces it.

### `sandbox` (development only)

`ELEMARKET_PAYOUT_DRIVER=sandbox` with `ELEMARKET_ENABLE_PAYOUT_SANDBOX=1` in
an isolated development environment. Nothing moves. Accounts ending in `0000`
fail, which is useful for testing the failure path.

## Operations

`/api/internal/wallet-settlement` runs every minute (scheduler and Vercel cron).
It releases matured funds, sends requested payouts and reads back unfinished
ones. A payout the provider never confirms after 8 attempts, or whose reported
amount or currency differs, becomes **needs_attention**: its money stays in
"being paid out" until someone checks it with the provider and settles it with
`wallet_settle_payout(<payoutId>, 'paid'|'failed', <providerReference>, <note>)`.

## Tests

- `npm test` includes the payout driver contract (signing, idempotency,
  rejection handling, webhook verification, fees).
- `npm run test:wallet:simulation` runs the lifecycle on an in-memory database.
- `npm run test:wallet:postgres` runs the adversarial suite (T01–T30) and the
  0216→0217 upgrade test on **real PostgreSQL**, with separate worker
  processes, injected provider faults, a crashed worker and, with
  `ELEMARKET_TEST_PG_RESTART_CMD`, a database restart. It needs
  `RUN_DB_INTEGRATION=1` and `ELEMARKET_INTEGRATION_DATABASE_URL` naming a
  database ending in `_test`; each run creates and drops its own database.
- `npm run simulate:wallet -- --out report.md` (same variables) writes the
  end-to-end simulation as Markdown, with the ledger before and after every step.

Payout providers in these tests are simulated adapters
(`scripts/helpers/mock-payout-provider.mjs`) with configurable capabilities and
injected faults. They prove the wallet's behaviour, not any real provider's.
