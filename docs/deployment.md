# Single-VPS Developer Beta deployment and recovery

**Current decision: NO-GO for public exposure.** This is a deployment procedure,
not evidence of a public deployment. Resolve the release blockers and complete
the verification gates before opening ingress. Keep this repository private.

## Configuration and construction

1. Use a supported Linux VPS with Docker Engine and Compose (Buildx >=0.17).
   Keep only SSH from trusted networks and eventual HTTPS/HTTP ingress open.
   PostgreSQL, Redis, app, scheduler and biometrics have no published ports.
2. Copy `.env.example` to `.env.production`, `chmod 600 .env.production`, and
   replace every host/identity/empty secret. Generate independent 32-byte hex
   secrets with `openssl rand -hex 32`; store encrypted recovery copies off VPS.
   The two data-encryption keys are essential to recovering encrypted records.
   Do not rotate them by simply replacing values; use the documented key
   migration logic and retain prior keys for backups.
3. Configure the five DNS names you control to the VPS. Caddy obtains public
   certificates after DNS and inbound ports 80/443 work. `.localhost` names use
   Caddy's private CA for local tests; that is not public TLS certification.
4. Keep `developer_beta`, facial authentication off, no biometric Compose
   profile, no live transaction adapters, and no preview settlement. Public
   signup must verify email ownership through a configured, tested delivery
   adapter. Local inbox emulators must never be exposed as real verification.
   SMS failure leaves merchants pending; storage-dependent operations also
   remain unavailable until a configured adapter is tested.
5. Review `docs/verification.md`, run its required gates, then build:

   ```sh
   docker compose --env-file .env.production config --quiet
   docker compose --env-file .env.production build app scheduler
   docker compose --env-file .env.production up -d --wait --wait-timeout 420
   ```

`config` without `--quiet` can reveal interpolated secrets. Do not paste it into
logs. The app checks the package/environment and migration checksum ledger
before binding its port. Migrations serialize with a PostgreSQL advisory lock.
Redis and PostgreSQL readiness precede app startup; app health precedes ingress
and scheduler startup. The scheduler needs up to five minutes for its first beta
job. Its idle heartbeat preserves the last actual job result.

Use immutable images. Record `docker compose images` plus image digests, source
commit, lockfile/checksum manifests and build inputs privately for each candidate.
Do not overwrite `.output` under a running Node process. Do not reuse these beta
instructions for live-money operations.

## Administration and recovery

- Create and verify the intended customer identity before first-owner bootstrap.
  `scripts/bootstrap-main-admin.mjs` is a trusted-console-only operation. Supply
  `ELEMARKET_BOOTSTRAP_EMAIL`, an audited `ELEMARKET_BOOTSTRAP_REASON` of at least
  16 characters and `ELEMARKET_BOOTSTRAP_APPROVAL=BOOTSTRAP_FIRST_MAIN_ADMIN` to
  that one process, with its database connection. It refuses any existing
  administrator/owner and an active merchant identity. Never expose it by HTTP.
- Set `ELEMARKET_EXECUTIVE_USER_ID` to the exact resulting identity. Sign into
  the executive host, enroll/verify TOTP, securely save its recovery codes, then
  sign out and back in. A password-only session cannot perform admin operations.
- Employees use the staff host and existing password/TOTP flow. Grant reviewed
  capabilities through staff management. Owners are protected from ordinary HR
  reassignment; delegated managers cannot exceed their own grants.
- For lost TOTP, use an unused Better Auth recovery code. For temporary lockout,
  wait for the configured lockout period and investigate the audit trail. For a
  routing error, restore known-good host/identity configuration. Revoke sessions
  and reset compromised credentials through authenticated procedures.
- Loss of both TOTP and recovery codes remains an unresolved recovery procedure;
  do not disable two-factor requirements, run first-owner bootstrap again, or
  edit grants to impersonate the executive. A separately reviewed, audited
  trusted-console recovery flow is needed before public operations.

## Backup and restoration

Take regular logical PostgreSQL backups and encrypted off-host copies of data
keys/configuration. A volume on the same VPS is not disaster recovery. Logical
backups have an RPO equal to the backup interval; this Compose configuration does
not configure WAL archiving/PITR. Back up object storage separately when enabled.
Do not expose backup files or include them in source releases.

Example using PostgreSQL's Unix socket inside its container (no password on the
command line):

```sh
umask 077
mkdir -p backups
docker compose --env-file .env.production exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backups/database.dump
```

Check exit status and nonzero size. `npm run verify:backup -- dump <path>` only
inspects an archive header; **it does not prove restoration**. Restore into a
fresh isolated database and compare schema/migration history, critical rows,
constraints and application operations before accepting a backup. Use
`pg_restore --exit-on-error`; never ignore restoration failures. Test that all
encryption keys needed for the restored rows remain available.

## Rollback and operational checks

1. Stop scheduler and put ingress into maintenance before a schema/config change.
   Take and restore-test a backup. Preserve existing image digests and encrypted
   configuration. Keep PostgreSQL volumes; do not run `down -v` on live data.
2. For an application-only rollback, pin app/scheduler to the previously verified
   image digests using a Compose override, and use `up -d --no-build --wait`.
   Confirm that the old application understands the current schema before use.
3. Do not delete a migration or edit its checksum to roll back. If backward
   compatibility is unproven, restore the backup into a **new** isolated database,
   start its matching image/config and validate it before switching ingress.
   Account for writes since the backup rather than silently discarding them.
4. After any change, verify `/api/health` over the public TLS entry point, both
   database/cache checks, marketplace rendering, private-path denials, TOTP,
   scheduler job health, log redaction and the absence of internal published
   ports. Then resume ingress and scheduler only after the gates pass.

Monitor HTTP 5xx/latency, database connections/disk, container restarts, Redis
fallback, scheduler last successful run, auth failures and backup freshness.
Forward structured logs to a restricted collector with bounded retention. Set
host/Docker log rotation and disk alerts; this repository does not install a
monitoring service or guarantee resource sizing for an unmeasured workload.

The audit's local HTTPS, migrations and logical restore tests are not a VPS
outage drill, public DNS test, penetration-testing certificate or operating SLA.
