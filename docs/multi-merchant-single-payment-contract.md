# ELEMARKET — single-charge checkout for multiple merchants

**Date:** 2026-11-15. **Status:** Provider split planning and Paystack adapter support committed; **not yet wired to live checkout**. This document defines the remaining transaction boundary. The current web and Android checkout still create separate merchant charges. Never advertise a single charge until the acceptance gates below pass.

## Required result

One customer authorizes **one** GHS charge for all selected merchants. ELEMARKET keeps separate authoritative merchant orders, reservations, commissions, delivery liabilities, refunds and seller histories. The payment provider atomically distributes each merchant's fixed share to verified provider subaccounts. ELEMARKET never credits a separately funded merchant wallet for funds already split at the provider.

## Verified provider capability

Paystack supports *dynamic transaction splits* with `type=flat`, `bearer_type=account`, and `subaccounts:[{subaccount,share}]`. For GHS, `share` is in pesewas. The provider's fees are borne by the main account. These capabilities are in `src/modules/payments/internal/adapters/providers/paystack.ts`; the provider-neutral contract is in `src/modules/payments/internal/adapters/payment.ts`. Other provider adapters must explicitly support `supportsMultiMerchantSplit`, or single-charge mode must be unavailable. Provider integration must be tested against actual provider capabilities/config before activation.

https://paystack.com/docs/payments/multi-split-payments/

## Allocation example

A customer buys product(s) from seller A (GH₵150) and seller B (GH₵200), and pays GH₵10 and GH₵20 for separate deliveries. With commission of GH₵15 and GH₵20, respectively:

| Payee | One provider charge: GH₵380 |
|---|---:|
| Seller A provider subaccount | GH₵135 |
| Seller B provider subaccount | GH₵180 |
| Platform provider account, merchandise commissions | GH₵35 |
| Platform provider account, earmarked delivery fees | GH₵30 |
| Total | **GH₵380** |

The platform account also pays the PSP fee out of its own share. Any underlying delivery-provider obligation must be settled through the applicable delivery-provider contract; it is not merchant income.

## Transaction implementation required **before enabling**

1. Retain one order + order items + reservation + per-merchant payment/accounting entry per merchant. Add one **group charge** (not N individual external payment attempts) and immutable links to all of those orders. Verify one customer owns every member; all quotes are current; all merchants are active and use compatible provider-direct settlement/subaccounts. Reject mixed providers, currencies or settlement modes unless the chosen provider contract explicitly supports them.
2. Freeze the exact split plan at charge initialization in a durable group-payment row and generate one deterministic provider reference. Use an atomic lease/idempotency key. No second provider charge can be created for the same group, including retries, device restarts, 500 errors, webhooks arriving before API success, or simultaneous app/web requests. A split may never be recalculated after the first provider call.
3. Authenticate, verify and reconcile the **one** group charge: signed webhook *and* independent provider read-back must match group reference, GHS amount and immutable allocation. Under one SQL transaction, consume every order reservation, record one provider receipt, and transition **all** member payment/order states exactly once. On mismatch/failure, do not partially dispatch or credit any seller. Expiry must not release stock for a group with unresolved provider charge.
4. Reconcile provider split outcomes as well as the total charge; provider reporting must prove the submitted subaccounts and pesewa shares were honored. A successful charge is not automatic proof that each seller received the correct provider-side settlement. A divergence goes to an operator exception queue and blocks unsafe automatic payouts.
5. Support per-merchant cancellations/refunds **against the shared external transaction**. All refund requests refer to the original single charge, but are uniquely bound to merchant order, refund ID, exact refundable balance and provider refund reference. Verify no over-refunding across orders. Process signed partial-refund callbacks against the exact refund ID; never treat one merchant's partial refund as a refund of the entire group. An uncertain refund is not blindly retried.
6. Record complete group receipt/merchant breakdown, customer status and merchant statements. The customer's checkout should show one confirmed final total and a single secure payment authorization. The server, not app/browser routing, determines payment URLs and payment status. Mobile/WebView must not trust an unverified deep-link payment URL.
7. Preserve the distinct provider-held wallet model. Wallet merchants cannot be included in a provider-direct split until a reviewed provider-legal/finance path handles their custody, holds, withdrawals, refunds and liabilities. Do not silently route the group proceeds to ELEMARKET's own bank account.
8. Provider adapters are opt-in: no vendor-specific hardcoding in business policy, API or schema. Keep existing single-merchant payment and refund flows working without regressions.

## Acceptance gates

- 2, 3, 10 merchants; mixed item quantities, 1-pesewa boundaries, discounts, commission overrides, varied delivery charges; exact totals and subaccount shares.
- Two simultaneous group-charge initializations; duplicate successful webhook; webhook before initialization-response; crashed/restarted server; stale lease; lost callback; delayed confirmation; verified provider mismatch; double charge / refund attacks.
- One of three merchant orders cancelled before charge, one merchant partially refunded after a 3-merchant successful charge, repeat refund notification, refund failure and reversal, provider split discrepancy, cash liability / settlement review.
- Product variants, stock, flash-sale/redemption consumption, dispatched orders, return windows, rider OTP and support/reconciliation cases do not diverge from single-merchant behavior.
- Payment-provider sandbox integration with actual dynamic-split and partial-refund APIs, including payload shape, GHS settlement behavior, fee bearer and provider account permissions.
- Unit tests + PostgreSQL concurrency/rollback simulations + Android poor-network/force-close + two physical customer devices. Merchant payout and withdrawal reports reconcile to provider statements; no duplicate merchant credit.
- Review the actual provider agreement, role and payment-services obligations before activating cross-merchant pooled collection.

**Do not mistake the new split calculator/provider-adapter capability for completed group checkout.** Enabling one external charge without the per-group authoritative webhook/refund state machine would be a serious financial defect.
