# Merchant wallet audit — 10 November 2026

Scope: the merchant wallet and payout system (migration 0216, `src/modules/wallet`)
audited against the directive "Provider-neutral merchant wallet, withdrawal safety
and financial integrity". Evidence was produced on PostgreSQL 16.15 with the
repository's production migrator. Provider behaviour was **simulated**: no real
provider was contacted and no money moved.

## A. Existing architecture (as found)

- **Collection.** Checkout charges through the payment adapter registry.
  Since 0216, a charge is stamped (write-once) as `provider_split` or
  `platform_wallet`. Only wallet charges are credited to the wallet, and only
  merchants with `settlement_model = 'platform_wallet'` (opt-in, admin-enabled)
  use it.
- **Ledger.** `wallet_ledger_entries` is append-only (trigger-enforced). Its
  buckets are withheld, available, processing, paid_out and fees.
  `merchant_wallet_balances` sums them.
- **Release.** `release_matured_wallet_funds` moves withheld to available when
  the order has rider-OTP-confirmed receipt, the longer of 24 hours or every
  item's return window has passed (owner decision of 10 Nov), and nothing is
  open: dispute, return or refund. This builds on the existing 24-hour
  post-receipt rule (`merchant_provider_withdrawal_eligibility`).
- **Payouts.** `wallet_request_payout` reserves (available → processing) under
  a per-merchant advisory lock, with a per-merchant idempotency key and one
  active withdrawal at a time. A worker sends through the payout driver
  registry and settles via `wallet_settle_payout`.
- **Legacy paths.** The escrow and settlement creators (`create_settlement_attempt`,
  `release_escrow`, `mark_escrow_release_pending`, `resolve_escrow_dispute`)
  raise "disabled"; the fund-release request functions no longer exist; the
  remaining confirm functions only act on legacy rows (none) and have no callers.
  **The wallet is the only payout initiation path.**

## B. Defects found (reproduced on PostgreSQL before any fix)

Reproduction script: `.sim/repro-defects.mjs` (run against merged `main` 8cf5bb1).

| # | Severity | Where | Reproduction | Financial impact |
|---|---|---|---|---|
| R3 | **Critical** | `wallet.server.ts` webhook, `wallet_settle_payout` (0216) | A payout recorded as failed was later reported paid by the provider. The webhook returned "duplicate"; the merchant re-withdrew. **Provider: two paid transfers; ledger: one.** | Undetected double payout |
| R1 | High | `wallet_apply_refund` (0216) | A refund after a full withdrawal reservation: available = **−95.00** | Negative balance; the next earnings were silently consumed |
| R2 | Medium | dispatch read `merchant_payout_accounts` live | A timed-out payout was retried to an account disabled meanwhile; the live row was used | A changed or compromised account row could redirect money |
| R4 | Medium | registry required idempotency | A provider without idempotent initiation could not be connected at all | Neutrality gap; no capability model |
| R5 | Medium | `wallet_request_payout` (0216) | Six GH₵ 1.50 withdrawals in a row were accepted | No amount or velocity limits |
| R6 | Low | contract | Timeout handling assumed idempotency; there were no durable attempt records, no explicit uncertain or cancelled states, and no reconciliation exceptions | Weaker audit trail and recovery |

Confirmed correct before fixes: 100 identical concurrent requests produced 1
payout, and 20 competing requests produced 1 reservation.

## C. Repairs

| Change | Files |
|---|---|
| Migration **0217** (additive): a recovery bucket instead of negative balances; database invariant trigger (deferred, per merchant); destination snapshot on withdrawals plus immutable payout accounts; states `submitting`, `uncertain`, `cancelled`; `wallet_payout_attempts` (durable, written before every send); `wallet_payout_events` (webhook inbox); `wallet_reconciliation_exceptions`; limits and cooling period in `wallet_request_payout`; late-success and conflict handling in `wallet_settle_payout`; audited admin resolution that refuses settled payouts; `wallet_cancel_payout`; `wallet_reconciliation_summary()`; value-preserving reclassification of any existing negative balance | `migrations/0217_wallet_payout_safety.sql`, `migrations.sha256.json` |
| Capability-declared provider contract; drivers no longer need idempotency to connect, and safety derives from their declared capabilities | `src/modules/wallet/internal/adapters/{payout,registry,signed-http,sandbox}.ts` |
| Orchestration rewritten: durable send, uncertain → read back → send again only if idempotent, otherwise quarantine; reconciliation, verification of settled payouts, provider listing comparison, inbox-backed webhooks | `src/modules/wallet/internal/wallet.server.ts` |
| Merchant cancel; admin reconciliation list, resolve and requeue (fresh session, finance capability) | `src/modules/wallet/internal/transport/merchant/wallet.functions.ts` |
| Wallet page: pending vs on hold, reserved or processing, failed, owed from refunds, canonical statuses, cancel, cooling period | `src/routes/merchant/wallet.tsx` |
| Reconciliation every 15 minutes | `src/routes/api.internal.wallet-settlement.ts` |

Commit hashes are listed in the pull request or the final report.

## D. Double-payment prevention (evidence)

| Threat | Mechanism | Test |
|---|---|---|
| Double click, replay, 100 identical requests | Per-merchant idempotency key, unique in PostgreSQL; replay returns the original | T01, T02, T26 |
| Competing requests, two devices | Per-merchant advisory lock plus a unique "one active withdrawal" index | T03, T04 |
| Two workers, duplicated jobs | `FOR UPDATE SKIP LOCKED` claim plus lease; the send is recorded under the lease | T05, T20 |
| Timeout, lost response | `uncertain`, read back, then send again only if the provider is idempotent, otherwise quarantine | T06, T07 |
| Crash after submission, database restart | Attempt row written before the call; recovery reads back | T08, T22 |
| Duplicate or conflicting callbacks | Inbox de-duplication; final states immutable; conflicts raise exceptions | T09, T10, T23 |
| External double payout | Provider listing comparison raises a critical exception | T27 |
| Late success after recorded failure | Booked (funds taken back) plus a critical exception | R3 rerun |
| Staff retrying a settled payout | `wallet_admin_resolve_payout` refuses; status trigger refuses | T21 |

## E. End-to-end simulation

See `docs/wallet-simulation-report-2026-11-10.md` (13 steps, ledger before and
after each, final reconciliation). Summary: GH₵ 115.00 collected per order
(GH₵ 100 products + GH₵ 15 delivery), GH₵ 5.00 commission, GH₵ 95.00 merchant
earning withheld, then released after the OTP handover and 24-hour hold. Partial,
concurrent, failed, timed-out, missing-callback, refund-raced, duplicated and
crashed withdrawals ran with the invariant holding at every step. Final:
entitlements 475 − refund debits 190 = 285 = withheld 95 + available 70 + paid
out 113 + fees 7. **0 invariant violations.** One open exception
(`duplicate_external_payout`, deliberately injected).

## F. Test evidence (final code, 10 Nov 2026)

| Command | Result |
|---|---|
| `npm test` | 43 / 43 pass (includes the payout driver contract) |
| `npm run check:architecture` (boundaries, contracts, provider neutrality) | pass |
| `npm run validate:deployment-package` (216 migration files, 0001–0217 with 0034 never used; checksums) | pass |
| `npm run typecheck`, `npm run lint`, `npm run build` | pass |
| `npm run test:payment:simulation` | 6 / 6 pass |
| `npm run test:wallet:simulation` (in-memory) | 11 / 11 pass |
| `npm run test:wallet:postgres` on PostgreSQL 16.15, with T22 restarting the server | **32 / 32 pass**: T01–T30, limits and cooling period, 0216→0217 upgrade |
| `npm run simulate:wallet` | 13 / 13 steps; invariant held at every step; 0 violations |

The repairs were made test-first: the reproductions in B ran against the
merged code before any fix and against the repaired code afterwards.

Gaps: concurrency was exercised with real parallel connections and separate
processes, not with deterministic interleaving at every statement. The simulated
providers prove the wallet's behaviour, not any real provider's. Delivery in
these tests creates the rider-OTP evidence directly instead of driving the
rider's SMS screens, which the delivery suites cover.

## G. Provider neutrality

T30 runs the same core code, unchanged, against three simulated adapters with
different declared capabilities:
`mocka` (idempotent + lookup + webhooks + listing), `mockb` (lookup only, not
idempotent) and `mockc` (webhooks only). Each paid out once. An unconfirmed send
was sent again only by `mocka`, and quarantined for `mockb` and `mockc`. Every
invariant held. The only per-provider code is the adapter; the core learns
capabilities from the adapter's declaration. The neutrality guard
(`check-provider-neutrality`) passes and now covers payout drivers.

## H. Remaining external requirements (cannot be verified locally)

- **Licensing:** whether holding merchant earnings in the platform's provider
  account and releasing them later is permitted for ELEMARKET under Bank of
  Ghana rules (Act 987) and the chosen provider's contract.
- **Provider guarantees:** that the real provider honours idempotency keys on
  transfers, offers authoritative status lookup, signs webhooks, and lists
  transfers. The adapter must declare only what is contractually guaranteed.
- **Hold compatibility:** that the provider permits holding collected funds for
  the 24-hour and return-window hold before disbursement.
- **Real account validation:** name matching between payout accounts and KYB
  records is not implemented.
- **Provider balance reconciliation:** comparing the provider's account balance
  with the wallet's total liabilities needs a balance API from the provider.

## I. Assessment

| Area | Assessment |
|---|---|
| Code correctness | All reproduced defects fixed with regression tests; full gate below |
| Ledger integrity | Append-only; database-enforced invariants at commit; no negative balances; upgrade preserves history |
| Payout safety | No blind retries; durable attempts; capability-driven recovery; quarantine when unsafe. **Exactly-once external execution is not claimed:** it depends on the provider honouring idempotency, which is detected (T27) but cannot be enforced locally. |
| Reconciliation | Exceptions recorded, never auto-forced; staff resolution audited |
| Integration readiness | Not ready for live money until the external requirements in H are confirmed with a real provider in its sandbox |
