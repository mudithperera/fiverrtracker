-- Users, billing, and usage.
--
-- Usage is stored as one row per user per UTC day rather than a running counter,
-- so daily quotas reset without a scheduled job and history stays inspectable
-- when someone disputes a limit.

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  google_sub    text unique not null,
  email         text not null,
  name          text,
  picture       text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists users_email_idx on users (email);

create table if not exists subscriptions (
  user_id                 uuid primary key references users (id) on delete cascade,
  stripe_customer_id      text unique,
  stripe_subscription_id  text unique,
  plan                    text not null default 'free',
  status                  text not null default 'inactive',
  interval                text,
  cancel_at_period_end    boolean not null default false,
  current_period_end      timestamptz,
  updated_at              timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx on subscriptions (stripe_customer_id);

create table if not exists usage_daily (
  user_id  uuid not null references users (id) on delete cascade,
  day      date not null,
  checks   integer not null default 0,
  primary key (user_id, day)
);

-- Stripe delivers webhooks at least once, so replays must be harmless.
create table if not exists processed_events (
  id            text primary key,
  processed_at  timestamptz not null default now()
);
