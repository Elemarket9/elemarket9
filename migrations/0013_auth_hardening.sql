-- ELEMARKET v1.33 auth hardening foundation.
--
-- 1. Explicit account role boundary for customer / merchant / admin paths.
--    Role elevation must be performed by trusted server-side workflows; clients
--    must never be allowed to write this column directly.
-- 2. Persistent Better Auth rate-limit storage for multi-instance deployments.
--
-- Better Auth's database rate limiter expects this model shape:
--   id          text primary key
--   key         text unique
--   count       integer
--   lastRequest bigint (epoch milliseconds)

alter table if exists "user"
  add column if not exists "role" text not null default 'customer';

-- Fail closed on malformed legacy data before adding the constraint.
update "user"
set "role" = 'customer'
where "role" is null or "role" not in ('customer', 'merchant', 'admin');

alter table if exists "user"
  drop constraint if exists "user_role_check";

alter table if exists "user"
  add constraint "user_role_check"
  check ("role" in ('customer', 'merchant', 'admin'));

create index if not exists "user_role_idx" on "user" ("role");

create table if not exists "rateLimit" (
  "id" text not null primary key,
  "key" text not null unique,
  "count" integer not null,
  "lastRequest" bigint not null
);

create index if not exists "rateLimit_lastRequest_idx"
  on "rateLimit" ("lastRequest");
