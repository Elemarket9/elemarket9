# CI and mobile security repair — 2026-10-14

Apply the repair ZIP over the repository root and commit every included file.
It is an update package, not a replacement for the entire repository. Existing
test suites stay in the repository; no new test files are included.

Changes:
- PostgreSQL health-check quoting is compatible with the Actions runner argument parser.
- Root jiti is pinned to the available 2.7.0 release; update package.json and lockfile together.
- Mobile local decoder resolution references a direct dependency, so clean npm installs work.
- Three unpatched upstream advisories are addressed by documented licensed local source forks.
- CI verifies source integrity and exercises advisory cases, then performs a cache-cleared export.
- Missing Expo peers and the supported Android cleartext configuration are included.

Local results: root registry audit zero; 420 package signatures verified and 189
attestations verified; typecheck, 22 unit tests, architecture and migration checksum
checks pass; lint has no errors and nine existing warnings; Node 22 production
build passes. Mobile fresh installation, typecheck, all 20 Expo doctor checks,
framework version alignment, advisory regressions and cache-cleared Android JS
export pass; registry audit reports zero known findings. Local forks are not
covered by the registry audit; see mobile/security/README.md for maintenance and
provenance. Native-device builds and the remote GitHub rerun remain unverified.
Docker is not installed on this machine. No checks were disabled to make CI pass.
