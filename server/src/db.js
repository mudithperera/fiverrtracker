/**
 * Postgres access.
 *
 * Thin on purpose: a handful of named queries rather than an ORM. The schema is
 * four tables and the query shapes are stable, so an ORM would add a dependency
 * and a mental model without removing any real work.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));

export function createDb(databaseUrl) {
  return postgres(databaseUrl, {
    // Neon and most managed Postgres require TLS; `prepare: false` keeps it
    // working through connection poolers such as PgBouncer in transaction mode.
    ssl: databaseUrl.includes('localhost') ? false : 'require',
    prepare: false,
    max: 10,
  });
}

/** Apply every .sql file in migrations/ in filename order, tracked in a table. */
export async function migrate(sql) {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const dir = join(here, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await sql`select name from schema_migrations`).map((row) => row.name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const contents = await readFile(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`insert into schema_migrations ${tx({ name: file })}`;
    });
    console.log(`migrated: ${file}`);
  }
}

// --- users -------------------------------------------------------------------

export async function upsertUser(sql, profile) {
  const [user] = await sql`
    insert into users (google_sub, email, name, picture)
    values (${profile.sub}, ${profile.email}, ${profile.name || null}, ${profile.picture || null})
    on conflict (google_sub) do update
      set email = excluded.email,
          name = excluded.name,
          picture = excluded.picture,
          last_seen_at = now()
    returning *
  `;
  return user;
}

export async function findUserById(sql, id) {
  const [user] = await sql`select * from users where id = ${id}`;
  return user || null;
}

// --- subscriptions -----------------------------------------------------------

/** Camel-cased so plans.js does not need to know about column naming. */
function toSubscription(row) {
  if (!row) return null;
  return {
    plan: row.plan,
    status: row.status,
    interval: row.interval,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    currentPeriodEnd: row.current_period_end,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
  };
}

export async function findSubscription(sql, userId) {
  const [row] = await sql`select * from subscriptions where user_id = ${userId}`;
  return toSubscription(row);
}

export async function findSubscriptionByCustomer(sql, customerId) {
  const [row] = await sql`
    select * from subscriptions where stripe_customer_id = ${customerId}
  `;
  return row ? { ...toSubscription(row), userId: row.user_id } : null;
}

export async function saveStripeCustomer(sql, userId, customerId) {
  await sql`
    insert into subscriptions (user_id, stripe_customer_id)
    values (${userId}, ${customerId})
    on conflict (user_id) do update set stripe_customer_id = excluded.stripe_customer_id,
                                        updated_at = now()
  `;
}

export async function saveSubscription(sql, userId, fields) {
  await sql`
    insert into subscriptions (
      user_id, stripe_customer_id, stripe_subscription_id, plan, status,
      interval, cancel_at_period_end, current_period_end, updated_at
    ) values (
      ${userId}, ${fields.stripeCustomerId}, ${fields.stripeSubscriptionId},
      ${fields.plan}, ${fields.status}, ${fields.interval || null},
      ${Boolean(fields.cancelAtPeriodEnd)}, ${fields.currentPeriodEnd || null}, now()
    )
    on conflict (user_id) do update set
      stripe_customer_id     = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      plan                   = excluded.plan,
      status                 = excluded.status,
      interval               = excluded.interval,
      cancel_at_period_end   = excluded.cancel_at_period_end,
      current_period_end     = excluded.current_period_end,
      updated_at             = now()
  `;
}

// --- usage -------------------------------------------------------------------

export async function checksToday(sql, userId) {
  const [row] = await sql`
    select checks from usage_daily
    where user_id = ${userId} and day = (now() at time zone 'utc')::date
  `;
  return row ? row.checks : 0;
}

export async function incrementChecks(sql, userId) {
  const [row] = await sql`
    insert into usage_daily (user_id, day, checks)
    values (${userId}, (now() at time zone 'utc')::date, 1)
    on conflict (user_id, day) do update set checks = usage_daily.checks + 1
    returning checks
  `;
  return row.checks;
}

// --- webhook idempotency -----------------------------------------------------

/** @returns {Promise<boolean>} true if this event has not been handled before. */
export async function claimEvent(sql, eventId) {
  const rows = await sql`
    insert into processed_events (id) values (${eventId})
    on conflict (id) do nothing
    returning id
  `;
  return rows.length > 0;
}
