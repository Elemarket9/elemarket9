# ELEMARKET Mobile

Native Expo/React Native client for ELEMARKET. It uses the same Better Auth identity as the web application.

## Authentication security
- Better Auth Bearer plugin on the server.
- Native sign-in reads `set-auth-token` from the auth response.
- Long-lived credential is stored only in `expo-secure-store` with device-only keychain accessibility.
- API requests send `Authorization: Bearer <token>`.
- Sign-out calls the server and removes the local token.
- No token is stored in AsyncStorage, localStorage, SQLite, logs, URLs, or analytics.
- The server resolves the user from the bearer session; the mobile client never sends a trusted user ID for authorization.

## Run
1. Copy `.env.example` to `.env` and set `EXPO_PUBLIC_API_BASE_URL` to the ELEMARKET API origin. Never commit the production domain as source code; Expo embeds this public value at build time.
2. `npm ci` (dependencies are aligned with Expo SDK 55).
3. `npx expo start`
4. Build with EAS or native `expo run:android` / `expo run:ios`.

EAS preview and production profiles use their matching EAS environments. Set
`EXPO_PUBLIC_API_BASE_URL` in each environment before building; the hostname is
not embedded in `eas.json`. This value is public build configuration, not a secret.
Release API origins must use HTTPS and contain no credentials, path, query or
fragment. Cleartext loopback is permitted only in a development build.

The mobile client includes secure authentication, marketplace browsing/search, profile management, cart, live delivery quotes, server-authoritative checkout, and an in-app WebView payment experience. Payment status is verified by the ELEMARKET server/provider before an order is presented as paid. The mobile client never implements authoritative pricing, order state, or payment verification locally.

## Validation

Run `npm run typecheck` and `npx expo install --check`. A JavaScript bundle can be checked with `npx expo export --platform android`; native device testing is still required before release.

## Dependency security update (2026-10-14)

The lockfile pins patched URI decoding (0.5.0) and Xcode UUID generation (11.1.1).
`security/decode-uri-component` is a small compatibility adapter: query-string 7
expects a callable CommonJS export, while the patched decoder has a default export.
The adapter is a direct local dependency, with its transitive override referencing
that direct dependency, so clean installs resolve the project path consistently.
The `patched-uri-decoder` dependency is the actual upstream patched package; the
adapter does not replace its decoding implementation or suppress audit findings.
Expo Router peers are explicitly installed. Android cleartext traffic remains
 disabled through the supported expo-build-properties config plugin.

The October 14 repair also supplies licensed local security forks for three
packages without published upstream patches. The registry audit now reports zero
known findings, but does not audit these forks: source review, integrity checks
and advisory regression checks are separate required CI gates. See
[security maintenance](security/README.md). Native device testing is still required.
