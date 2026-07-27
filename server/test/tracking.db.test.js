/**
 * Integration tests against a real Postgres.
 *
 * Skipped unless TEST_DATABASE_URL is set, so `npm test` stays runnable without a
 * database. Everything here is SQL behaviour — sharing scans across users,
 * transactional result writes, index-backed lookups — which unit tests with a
 * mocked driver would assert nothing about.
 *
 *   createdb rankpeek_test
 *   TEST_DATABASE_URL=postgres://localhost/rankpeek_test npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addTrackedKeyword,
  completeScanRun,
  countTrackedKeywords,
  createDb,
  dueScanTargets,
  failScanRun,
  migrate,
  rankHistory,
  recentRun,
  rescheduleTracked,
  startScanRun,
  upsertUser,
} from '../src/db.js';

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  test('database tests skipped (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
} else {
  const sql = createDb(url);

  test.before(async () => {
    // Fresh every run: these assert on counts and ordering, which stale rows break.
    await sql`drop table if exists scan_results, scan_runs, tracked_keywords cascade`;
    await sql`drop table if exists processed_events, usage_daily, subscriptions, users cascade`;
    await sql`drop table if exists schema_migrations cascade`;
    await migrate(sql);
  });

  test.after(async () => {
    await sql.end();
  });

  const makeUser = (n) =>
    upsertUser(sql, { sub: `google-${n}`, email: `user${n}@example.com`, name: `User ${n}` });

  test('migrations create the tracking schema and are idempotent', async () => {
    await migrate(sql); // second run must be a no-op, not an error
    const [row] = await sql`
      select count(*)::int as count from information_schema.tables
      where table_name in ('scan_runs', 'scan_results', 'tracked_keywords')
    `;
    assert.equal(row.count, 3);
  });

  test('two users tracking one keyword produce a single scan target', async () => {
    // The whole cost model rests on this: proxy bandwidth must scale with
    // keywords, not subscribers.
    const a = await makeUser('a');
    const b = await makeUser('b');
    await addTrackedKeyword(sql, a.id, {
      keyword: 'logo design',
      username: 'seller_a',
      country: 'default',
      sortModes: ['relevance'],
    });
    await addTrackedKeyword(sql, b.id, {
      keyword: 'logo design',
      username: 'seller_b',
      country: 'default',
      sortModes: ['relevance'],
    });

    const targets = await dueScanTargets(sql, { now: new Date(Date.now() + 1000) });
    const logo = targets.filter((t) => t.keyword === 'logo design');
    assert.equal(logo.length, 1, 'one scan serves both subscribers');
    assert.equal(logo[0].sort_mode, 'relevance');
  });

  test('sort modes fan out into separate targets', async () => {
    const c = await makeUser('c');
    await addTrackedKeyword(sql, c.id, {
      keyword: 'video editing',
      username: 'seller_c',
      country: 'default',
      sortModes: ['relevance', 'best_selling'],
    });
    const targets = await dueScanTargets(sql, { now: new Date(Date.now() + 1000) });
    const modes = targets.filter((t) => t.keyword === 'video editing').map((t) => t.sort_mode);
    assert.deepEqual(modes.sort(), ['best_selling', 'relevance']);
  });

  test('a completed run is stored whole and readable as rank history', async () => {
    const run = await startScanRun(sql, {
      keyword: 'logo design',
      country: 'default',
      sortMode: 'relevance',
    });
    assert.equal(run.status, 'running');

    await completeScanRun(sql, run.id, {
      pagesScanned: 2,
      results: [
        { position: 1, username: 'someone_else', slug: 'a-gig', gigId: '1_0', title: 'A' },
        { position: 2, username: 'seller_a', slug: 'my-gig', gigId: '2_1', title: 'Mine' },
        { position: 3, username: 'third_party', slug: 'c-gig', gigId: '3_2', title: 'C' },
      ],
    });

    const [stored] = await sql`select * from scan_runs where id = ${run.id}`;
    assert.equal(stored.status, 'ok');
    assert.equal(stored.results_count, 3);
    assert.ok(stored.finished_at, 'run is closed');

    const history = await rankHistory(sql, {
      keyword: 'logo design',
      country: 'default',
      sortMode: 'relevance',
      username: 'seller_a',
    });
    assert.equal(history.length, 1);
    assert.equal(history[0].position, 2, 'rank comes from the shared run, not a private scan');
  });

  test('recentRun finds a fresh run and ignores an old one', async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const fresh = await recentRun(sql, {
      keyword: 'logo design',
      country: 'default',
      sortMode: 'relevance',
      since,
    });
    assert.ok(fresh, 'the run just completed counts as fresh');

    const tomorrow = new Date(Date.now() + 60 * 60 * 1000);
    const stale = await recentRun(sql, {
      keyword: 'logo design',
      country: 'default',
      sortMode: 'relevance',
      since: tomorrow,
    });
    assert.equal(stale, null, 'nothing counts as fresh in the future');
  });

  test('a failed run is never mistaken for a successful empty one', async () => {
    const run = await startScanRun(sql, {
      keyword: 'blocked keyword',
      country: 'default',
      sortMode: 'relevance',
    });
    await failScanRun(sql, run.id, 'blocked', 'PerimeterX wall');

    const [stored] = await sql`select * from scan_runs where id = ${run.id}`;
    assert.equal(stored.status, 'blocked');
    assert.match(stored.error, /PerimeterX/);

    const found = await recentRun(sql, {
      keyword: 'blocked keyword',
      country: 'default',
      sortMode: 'relevance',
      since: new Date(Date.now() - 3600e3),
    });
    assert.equal(found, null, 'a blocked run must not satisfy "already scanned today"');
  });

  test('rescheduling moves every subscriber to the same keyword forward', async () => {
    const next = new Date(Date.now() + 24 * 3600e3);
    await rescheduleTracked(sql, { keyword: 'logo design', country: 'default' }, next);

    const targets = await dueScanTargets(sql, { now: new Date() });
    assert.equal(
      targets.filter((t) => t.keyword === 'logo design').length,
      0,
      'no longer due for anyone',
    );
  });

  test('tracked keyword counts drive plan limits', async () => {
    const d = await makeUser('d');
    assert.equal(await countTrackedKeywords(sql, d.id), 0);
    await addTrackedKeyword(sql, d.id, {
      keyword: 'seo',
      username: 'seller_d',
      country: 'default',
      sortModes: ['relevance'],
    });
    assert.equal(await countTrackedKeywords(sql, d.id), 1);

    // Re-adding the same keyword must not double-count against the quota.
    await addTrackedKeyword(sql, d.id, {
      keyword: 'seo',
      username: 'seller_d',
      country: 'default',
      sortModes: ['relevance', 'best_selling'],
    });
    assert.equal(await countTrackedKeywords(sql, d.id), 1);
  });
}
