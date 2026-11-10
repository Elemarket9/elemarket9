# Merchant wallet

The merchant wallet shows each merchant what they have sold, what is withheld,
what is available to withdraw, what is being paid out and what has been paid,
and it sends payout commands to whichever payout provider ELEMARKET connects.

## Custody boundary

Customer money stays in ELEMARKET's account **at the connected payment
provider**. ELEMARKET never holds funds itself: the wallet is a ledger of what
each merchant is owed, plus the instructions it sends the provider to pay them.
Have this arrangement reviewed against Bank of Ghana rules (Payment Systems and
Services Act, 2019, Act 987) before going live.

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
| Release | withheld → **available** once the customer confirmed delivery by rider OTP, every item's return window (minimum 24 hours) has passed, and there is no open dispute, return or refund |
| Refund processed | − merchant's proportional share, from withheld first, then available (available can go negative; withdrawals wait until it recovers) |
| Withdrawal requested | available → **processing** |
| Payout paid | processing → **paid out** (net) + **transfer fees** |
| Payout failed | processing → available |

The merchant pays the transfer fee: it is deducted from the amount withdrawn.
One withdrawal can be in progress per merchant. Only the merchant owner can
withdraw or add payout accounts, after a fresh sign-in; admins can only view.

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
- `npm run test:wallet:simulation` runs the full lifecycle on an in-memory
  database: sale, withheld, release, dispute hold, withdrawal paid, withdrawal
  failed and returned, refund, append-only ledger, and no credit for
  provider-direct merchants.
