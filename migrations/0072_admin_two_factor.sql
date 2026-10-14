-- Better Auth 2FA schema for phishing-resistant administrator hardening.
alter table "user" add column if not exists "twoFactorEnabled" boolean not null default false;
create table if not exists "twoFactor" (
  "id" text not null primary key,
  "userId" text not null references "user"("id") on delete cascade,
  "secret" text not null,
  "backupCodes" text not null,
  "verified" boolean not null default true,
  "failedVerificationCount" integer not null default 0,
  "lockedUntil" timestamptz
);
create unique index if not exists "twoFactor_userId_uq" on "twoFactor"("userId");
