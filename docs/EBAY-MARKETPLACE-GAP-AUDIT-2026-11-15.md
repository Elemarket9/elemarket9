# ELEMARKET — independent eBay benchmark and source-code audit

**Date:** 2026-11-15 UTC. **Baseline:** `aafafab7` on `main`, with this branch addressing one Android payment-deep-link weakness.
**Scope:** source repository, migrations, Github CI; official eBay seller/buyer policies, Ghana supervisory guidance. **Not assessed:** deployed VPS, live PSP or carrier accounts, real Android devices, merchant inventory truth, financial statements, real users.

## Decision
**Substantial, test-backed marketplace implementation; not independently proven eBay-grade customer operations.** Source/tests are a prerequisite, not a proxy for conversion, merchant stock quality, completed delivery, fraud losses, or fast refunds. Readiness is separated into code, integration, field, and launch evidence. This is a risk-based engineering assessment, not a commercial success forecast.

## Source-evidenced strengths

- Modular monolith with PostgreSQL, transactional inventory, migrations, idempotent checkout and payment intents: `src/modules/ordering/internal/checkout.ts`, `migrations/0214_logic_checkout_inventory_and_money.sql`.
- Provider-neutral money boundaries, signed payment webhooks, payment verification/reconciliation, refund exceptions, provider-held seller wallet, append-only financial ledger, dual approval: `src/modules/payments/internal/*`, `src/modules/wallet/internal/*`, `migrations/0216_merchant_wallet.sql`, `migrations/0217_wallet_payout_safety.sql`, `migrations/0223_wallet_webhook_retry_lease.sql`.
- Product discovery with attributes, search, ranking, product media, variants, SEO/sitemaps, verified-purchase reviews and wishlists: `src/modules/catalog/internal/search.server.ts`, `src/modules/engagement/internal/customer-engagement.functions.ts`.
- Seller workspace with listings, inventory, orders, finance, payouts, CSV, ads and enterprise integrations: `src/routes/merchant/dashboard.tsx`, `src/routes/merchant/wallet.tsx`.
- Role/host isolation, seller moderation, merchant registration, rate limiting, admin audit, return processing, OTP handover and carrier modules.
- GitHub CI verifies source, TypeScript, lint, unit/integration simulations, PostgreSQL migrations/tests and Android export; Docker image build passes on baseline.

## Gap and risk register

| Priority | Finding and evidence | Remediation and acceptance test |
|---|---|---|
| P0 | Android payment WebView previously accepted checkout URL via deep-linkable route params (`mobile/app/payment.tsx`). The route can be invoked without an authenticated marketplace-sourced checkout address. | This branch removes the URL param; re-fetches by authenticated paymentId and validates HTTPS. Test forged deep links, valid provider redirect, payment completed/failure and two-provider group after a cold restart on physical Android. |
| P0 | No live PSP payment/refund/payout certification or actual carrier handover evidence was inspected. CI uses mocks/Postgres, not live settlement. | Written provider contract and API proof for success, delayed webhook, lost response, chargeback, refund, payout duplicate, provider outage; track discrepancies and sign off before live traffic. |
| P0 | `compose.yaml` backs PostgreSQL into `backup_data` local volume with 7-day cleanup. No off-host replication or PITR is configured. | Encrypted offsite backups with monitored daily copy, at least one independent restore drill and explicit measured RPO/RTO; test losing the entire VPS. |
| P0 | Android `mobile/app/checkout.tsx` calculates a cart-based displayed total and starts PSP payment without an explicit review of authoritative server checkout totals (unlike web). | Show server order totals, per-merchant delivery fee, discounts, amount to charge; require explicit confirmation before intent, re-quote on expiry/price changes and test incorrect cart totals. |
| P1 | Web multi-merchant checkout creates independent sequential provider charges (`src/routes/checkout.tsx`, `src/routes/payment.return.tsx`). Buyers can end with partly paid order groups. | Provide coherent group-status UX and recovery/refund rules; evaluate one PSP-collected checkout with contractually allowed provider-side allocation. Prove 2–3 merchant completion/cancel/partial failure. |
| P1 | Product/search pages are relatively rich; Android app has no native product-details/variants, buyer order history, disputes, returns, customer support or seller verification explanation. `mobile/app/index.tsx` sends variants to web. | Achieve full core journey in Android, including photo/variants, verified seller context, receipts, tracking, return/dispute and support; test on entry-level Ghana handsets and poor networks. |
| P1 | `migrations/0131_atomic_manual_merchant_approval.sql` records automated business KYB status but sets merchant verified=true after manual approval as long as email and phone checks pass. | Define exactly what “Verified seller” warrants; record manual verification evidence, reviewer, time and expiration, customer-facing verification meaning. Challenge with invalid docs and revoked seller. |
| P1 | `src/modules/merchants/internal/transport/merchant/dashboard.functions.ts` shows 24-hour provider-direct eligibility while wallet funds can be held for 7 days or product return window under `migrations/0218_return_policy_guarantee.sql`. | Separate provider-direct and wallet settlement projections; show actual per-order hold reasons and release deadlines. Assert no promise of immediately withdrawable money while funds are held. |
| P1 | `src/modules/merchants/internal/sales-insights.server.ts` counts paid orders by *current* order status. Orders later refunded/disputed can disappear from historical gross sales; net/refund reports not comprehensive. | Base gross sales on immutable verified payment events and add refunds/chargebacks/fees/net separate; reconcile period reports to wallet ledger and PSP statements. |
| P1 | Merchant operations dashboard loads only newest 50 products and 100 orders per merchant; client search only filters those rows. Wallet history is paginated separately. | Server-side pagination, filters, searches, exports, SLA indicators for every merchant order/listing; verify 10k SKU, 100k orders without client or DB exhaustion. |
| P1 | Carrier pricing uses one deployment-selected `ELEMARKET_DELIVERY_PROVIDER`; carrier dispatch can remain manual if no `..._DISPATCH_ENDPOINT` is configured (`src/modules/logistics/internal/adapters/delivery.server.ts`). | Verify actual service availability, collection, OTP, tracking, return pickup, timeouts and cancellation across routes, operators and holidays; create partner SLA/escalation playbooks. |
| P1 | Marketplace return guarantee defaults to 7 days for faulty/not-as-described, vs eBay's generally 30-day window for eligible not-as-described requests. | Make buyer protection simple and reliably enforced, evaluate longer coverage for suitable categories with fee/hold economics; set resolution SLA, responsibility and escalation. Never promise stronger protection than provider refund contracts support. |
| P1 | Browser E2E, field Android tests, actual performance, load/stress with full data, production uptime and support staffing are not established by passing CI. | Release gates: staging simulated whole order, provider sandbox transaction/refund, physical Android+weak data, real rider/pickup handover, backup restore, reconciliations, then limited paid pilot. |
| P2 | `src/modules/catalog/internal/search.server.ts` uses a deliberately capped candidate pool (starting at 2k) and sampled facets (up to 5k), but no measured relevance/zero-result evaluation on actual Ghana query sets in this audit. | Benchmark representative Ghana product searches, variants, price filters, offline stocks, conversion and ranking fairness; track zero-result and search-to-cart rates. |
| P2 | Seller tools have basic advertising impressions/clicks and sales charts but lack eBay-grade marketplace research, attribution, campaign ROAS, seller-level case defects and historical seller service benchmarking. | Add accurate order-resolution metrics (late dispatch, seller cancellations, cases escalated, refunds, repeat buyers), product profitability and attribution before advanced research. |
| P2 | More categories and enterprise functions add operating burden; commercial product/merchant liquidity is unproven. | Launch narrow catalog/region with real merchants and available inventory; measure demand/supply matching, net contribution and repeat purchases before broad expansion. |

## Comparison standard (not feature parity as a gate)

eBay Seller Hub's public tools cover orders, listings, marketing, advertising, store, performance, payouts, research, and CSV/XLSX reports:
https://www.ebay.com/help/selling/fees-and-costs/fees-you-pay?id=4095

eBay evaluates seller defects and unresolved customer cases:
https://www.ebay.com/help/policies/selling-policies/seller-standards-policy?id=4347

eBay Money Back Guarantee, eligible item-not-as-described periods and seller response timing:
https://www.ebay.com/help/policies/ebay/ebay?id=4210

Ghana Bank of Ghana licensing guidance and Payment Systems and Services Act 2019, Act 987:
https://www.bog.gov.gh/notice/licensing-and-authorisation-of-payment-service-providers/
https://www.bog.gov.gh/fintech-innovation/licence-categories/

Ghana Data Protection Act 2012, Act 843 (data-controller registration):
https://dataprotection.org.gh/wp-content/uploads/2025/05/Data-Protection-Act-2012-Act-843.pdf

Provider-held custody does not, by itself, settle which regulated payment activities ELEMARKET performs. Obtain a written PSP contract/legal classification of the precise flow before going live.

## Pilot plan / gates

1. **Code/security:** repair deep-link payment trust, final server-backed Android amount confirmation, checkout partial-group recovery, role/OTP/return tests; source and Postgres CI green.
2. **Integration:** merchant onboarding/KYB manual evidence, live-like payment sandbox / refunds / payout reconciliation, carrier quote to assigned rider to OTP receipt, return pickup and refund. Every scenario has immutable IDs and audit logs.
3. **Infrastructure:** five hosts, HTTPS/proxy/2FA, secrets, monitoring and alerting, separate offsite backup with restore, load test, controlled rollback.
4. **Field:** 10–20 actual businesses within one supported geography, item stock and pricing audits, poor-network Android purchase, real courier pickup/delivery, prompt support, measured merchant payout once legal/provider flow signed.
5. **Growth:** track active available listings, qualified search-to-product, cart-to-paid, paid-to-delivered on-time, disputed/late cases, support resolution time, repeat customer orders, seller retention, customer acquisition costs, net contribution per completed order. Scale only when locally measured operations remain reliable.

**Interpretation:** an eBay-grade marketplace is first a system that reliably completes and resolves actual orders. Advanced monetization and feature breadth come after trust, payment safety and fulfillment.

## Addendum: code-reproduced findings from the second eBay benchmark (same day)

A second, independent benchmark ran against the back-office branch (PR #33) and reproduced each item below on a migrated PostgreSQL 16 database. It is merged here so there is one eBay audit document, not two. Items already in the register above are cross-referenced rather than repeated.

| ID | Severity | Finding (reproduced) | Relation to register above |
|---|---|---|---|
| EB-01 | Critical | A customer dispute can never be resolved or refunded: `prepare_provider_refund_for_dispute` has no caller, the admin refund path refuses any order past `confirmed`, and a return cannot be opened while a dispute is open. The order stays `disputed`. | New |
| EB-02 | High | Default `provider_direct` settlement pays the seller at payment time; refunds then come from ELEMARKET's balance with no record of what the seller owes. | Extends the P1 "24-hour eligibility" row |
| EB-03 | High | Returns after delivery (including the 7-day faulty-item guarantee) can never reach a refund: nothing creates a refund request for a delivered order. | Extends the P1 "return guarantee" row |
| EB-04 | High | The seller alone can reject a `damaged` / not-as-described return; no escalation to ELEMARKET. | New |
| EB-05 | Medium | Disputes have no opening window, type, evidence or seller response step (one was accepted 400 days after delivery). | New |
| EB-06 | Medium | Public product Q&A answers are published unmoderated, so a seller can post "WhatsApp me and pay MoMo direct". | New |
| EB-07 | Medium | `verified=true` is granted even when the business-registry check was rejected. | Same as the P1 "Verified seller" row (now reproduced) |
| EB-08 | Medium | Brand authorization only runs when `brand_id` is set; the free-text `brand` field bypasses it. | New |
| EB-09 | Medium | The merchant health score (shared with financing providers) counts abandoned unpaid checkouts as seller cancellations. | New |
| EB-10 | Medium | A payout account in any name is accepted and can withdraw after the cooldown; no alert to the owner; no seller 2FA. | New |
| EB-11 | Low | Seller service-quality inputs are partly constants (late-shipping and response rate stored as 0.5); `merchant_service_controls` is never applied. | Extends the P2 "seller-level case defects" row |
| EB-12 | Low | Sellers receive the buyer's full delivery address although ELEMARKET riders deliver. | New |

Launch blockers from this addendum, in order: a guarantee case system that can actually refund (EB-01, EB-03, EB-04, EB-05); paying sellers after delivery by default (EB-02); real seller identity checks (EB-07, EB-10). Ghana VAT / E-VAT invoicing on ELEMARKET's own fees also needs a tax adviser's confirmation before launch.
