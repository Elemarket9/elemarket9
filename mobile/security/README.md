# Mobile dependency security maintenance

These are local, licensed source forks, not upstream releases. The package names
explicitly identify ELEMARKET ownership; version 1.0.0 is the local fork version.
Do not treat npm audit's zero registry findings as a review of the fork code.

| Local package | Upstream basis | Source fix |
| --- | --- | --- |
| braces | braces 3.0.3 (MIT) | Bound brace/parenthesis parser nesting at 128; iteratively validate AST depth, cycles and node count before recursive walkers. |
| node-forge | node-forge 1.4.0 (BSD-3-Clause or GPL-2.0) | Reject extra nested DigestAlgorithm elements and non-empty NULL parameters during RSA PKCS#1 v1.5 verification. |
| sprintf-js | sprintf-js 1.0.3 (BSD-3-Clause) | Bound e/f/g numeric precision to the ECMAScript range, including a minimum of 1 for g, without mutating cached tokens. |
| decode-uri-component | decoder adapter, forwarding to upstream decode-uri-component 0.5.0 | Keep the callable CommonJS interface used by query-string 7. |

Each source fork contains the upstream license and UPSTREAM.json recording source
file hashes before modification. manifest.json records the current fork files.
CI checks integrity and actual dependency resolution, then verifies deeply nested
patterns/ASTs, valid brace expansions, precision attacks, valid RSA signatures,
malformed signed DigestAlgorithm values, URI decoding and UUID bounds. These
checks are inline in the workflow; no additional test files are required.

All local packages are direct dependencies. Transitive overrides reference the
direct dependency using npm's dollar reference, avoiding relative paths being
resolved inside an intermediate dependency during clean installs. Keep these
folders, package.json and package-lock.json together when uploading changes.

Review source changes and run the regressions before refreshing the manifest.
When official compatible patches become available, replace the local forks with
those releases and rerun clean-install, advisory regressions, Expo doctor and a
cache-cleared Android export. This adds a maintenance responsibility until then.
No package signature is claimed for local code. A successful JS bundle is not
native Android/iOS release certification.

Advisories addressed:
- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- https://github.com/advisories/GHSA-86w9-cpqp-85rv
- https://github.com/advisories/GHSA-hp3w-g68c-fv3c
- https://github.com/advisories/GHSA-vcc3-ghjq-m6fr
- https://github.com/advisories/GHSA-w5hq-g745-h8pq
