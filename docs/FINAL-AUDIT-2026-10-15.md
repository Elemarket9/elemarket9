# Final source audit and marketplace comparison — 2026-10-15

## Assessment

Elemarket is a feature-rich release candidate suitable for controlled staging verification. This audit does not establish unrestricted public-launch readiness or operational parity with eBay or Jumia Ghana. Green Docker and mobile builds establish packaging success, not real payment settlement, delivery performance, recovery capacity or production security certification.

All fixes were made in the Desktop elemarket9 project. Dockerfile and CI workflow jobs were not changed. No production credentials, domains or identities were added to code. Temporary tools and test files were kept outside this repository and removed after verification. Existing project dependencies and legacy verification helpers were not installed by this run.

## Confirmed issues addressed

1. **Mobile API-origin boundary (defense in depth).** The client accepted paths beginning with slash/backslash combinations that URL parsing can resolve to another host. The destination is now resolved and checked against the configured origin before SecureStore is accessed. Redirect following cannot be enabled by a caller. Base URLs reject userinfo, paths, query strings, fragments and non-HTTPS release configuration. Cleartext loopback is limited to development. No attacker-controlled call site supplying a full path was established; this is a verified helper-boundary weakness, not evidence of an observed token theft.
2. **Payment queue concurrency.** Polling, navigation callbacks and repeated taps could overlap and advance the next-payment queue more than once. In-flight and handled-payment guards serialize work; stale results and work after unmount are ignored. A simultaneous-tap regression verified exactly one status request, next intent, queue save and navigation. Server/provider settlement remains authoritative.
3. **Backup validation false positive.** The previous checker accepted any file starting with the five bytes PGDMP. It now requires a compatible pg_restore to read the archive and checks the required financial/audit table definitions. It rejects truncated and incomplete archives and explicitly warns that archive listing is not proof of a data restore. A separate synthetic archive restored successfully and its row survived; no actual production backup was supplied or restored.
4. **Startup credential disclosure on malformed Redis configuration.** An uncaught URL parsing exception echoed its raw input, potentially including credentials. A regression reproduced that behavior without displaying the test value. The new failure prints a sanitized message; complete synthetic configuration still passes, and missing authentication secrets still fail closed.
5. **Hardcoded mobile deployment hostname and missing example configuration.** EAS build profiles now use their respective preview/production environments, and mobile/.env.example supplies the documented variable name. Set EXPO_PUBLIC_API_BASE_URL in both EAS environments before native builds. The configured value is public build configuration. This audit did not access or populate the user's EAS account. App store identifiers and branding remain stable.
6. **Cross-platform security-source integrity.** Sixteen maintained security files had CRLF hashes that Git's automatic LF conversion would change. Git attributes now preserve the exact licensed source bytes. All 71 locked security files and all 187 SQL migrations were checked against Git-staged bytes, including Windows automatic conversion. No vendored source implementation or hash acceptance rule was weakened.
7. **Hook and lint cleanup.** Applied reviewed effect dependencies and unused-import cleanup to this actual Desktop copy. Lint and web type checking passed.

## Evidence from this run

- Fallow 3.33.1 produced 99 security candidates. These are unverified heuristics, not 99 vulnerabilities. The two high-ranked candidates were inspected: the biometric target is scoped deployment configuration behind an opt-in feature, and the merchant outbox uses a pinned public address and TLS. Sample SQL candidates use fixed fragments and parameterized values; query intent regex patterns are constant. This was targeted triage, not a formal proof that every candidate or runtime path is safe.
- Clean web and mobile dependency installs passed in an external temporary workspace.
- Registry audits returned zero known vulnerabilities for both packages. Registry scanning does not independently assess the maintained local mobile forks.
- 420 registry signatures and 189 package attestations verified.
- Architecture/module/provider-neutrality checks, 187 migration checks, web/mobile type checks, lint, web production build, Expo compatibility and Android JavaScript/Hermes export passed.
- The actual mobile API helper and payment component passed targeted behavioral regressions. Backup truncation/missing-table/valid-archive checks and an isolated PostgreSQL 18 synthetic restore passed. Production startup configuration checks passed, including secret-safe error handling.
- Build warnings about browser externalization of Node modules, upstream PGlite eval use, package deprecations and temporary React test-renderer deprecation remain. These were not suppressed and are not equivalent to confirmed exploits. A dedicated browser bundle/performance review remains worthwhile.

## Comparison with eBay and Jumia Ghana

This compares documented public capabilities and operational evidence with Elemarket source and local verification. It is not an audit of either competitor's internal security or a claim that they are risk-free.

| Area | Elemarket evidence | Mature-marketplace benchmark and remaining gap |
|---|---|---|
| Catalog and seller tools | Catalog, search/EIDE, variants, seller workspaces and moderation are implemented. | Demonstrate inventory accuracy, listing quality and seller service performance with real merchants. Source breadth does not prove search quality or seller reliability. |
| Buyer protection and returns | Refund/request/support workflows and server-side ownership checks are present. | eBay publishes eligibility, deadlines and escalation rules. Elemarket still needs operational dispute staffing, funded/refundable transactions and measured resolution outcomes. |
| Payments | Signed webhooks, provider verification, idempotency contracts, recovery workers and ownership checks are implemented. | Real charge/refund/reconciliation and interruption cases must be completed with the selected providers. No live-provider certification was supplied. |
| Delivery | Configured quote/dispatch adapters and workers are present. | Jumia publishes logistics and Ghana warehouse operating evidence. Elemarket has no comparable delivery success, stock handling or return-logistics evidence in this audit. |
| Reliability | Single-VPS deployment, health checks, rate limiting, job recovery and backup tooling exist. | Actual host restore drills, capacity measurements, uptime history, alert delivery and operator response must be demonstrated. |
| Native mobile | SecureStore bearer storage, guarded API access and Android bundle export are verified locally. | Signed store builds, physical-device/OS tests, customer account recovery and TOTP-capable mobile sign-in need separate acceptance. The mobile sign-in currently has no second-factor challenge UI. |

eBay's published standards and buyer-protection process: [seller standards](https://www.ebay.com/help/policies/selling-policies/seller-performance-policy/seller-performance-standards?id=4347), [Money Back Guarantee](https://www.ebay.com/help/eBay/protects/sellers?id=4210).

Jumia's published evidence: [marketplace and logistics operations](https://investor.jumia.com/our-company/), [Ghana warehouse expansion](https://investor.jumia.com/news/news-details/2024/Jumia-Ghana-Expands-Operations-with-New-State-of-the-Art-Warehouse/default.aspx), [Ghana operating results](https://investor.jumia.com/news/news-details/2025/Jumia-Releases-Preliminary-KPIs-For-The-Two-Months-Ended-November-30-2025-Highlighting-a-Successful-Black-Friday-Event/default.aspx).

Expo configuration reference: [EAS environments](https://docs.expo.dev/eas/environment-variables/usage/).

## Public-launch decision

Proceed with controlled staging and a limited pilot after setting the actual build/runtime configuration. Do not treat this report as approval for unrestricted public financial activity. The outstanding evidence is:

1. Actual provider-backed payment, refund, cancelled/expired checkout, lost-webhook recovery and delivery acceptance.
2. Restore a real host backup with its encryption/configuration recovery material, and verify required records and application behavior. The synthetic restore in this audit is not that drill.
3. Measure representative traffic and concurrent checkout behavior on the intended VPS, plus scheduler outage/retry behavior and alert delivery. No supported capacity number or SLA is established here.
4. Test signed native apps on physical devices, including account recovery, enabled-TOTP accounts, background/resume and interrupted payments. Set the EAS environment API origin first.
5. Establish real seller verification, inventory controls, return/dispute staffing and customer response targets. Feature screens alone cannot provide eBay/Jumia-level marketplace operations.

No Docker was installed or run, no public deployment was performed, and no claim of independent penetration testing, regulatory certification or competitor-scale operation is made.
