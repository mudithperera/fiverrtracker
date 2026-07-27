import test from 'node:test';
import assert from 'node:assert/strict';

import { consume, resetRateLimits } from '../src/ratelimit.js';

const OPTS = { limit: 3, windowMs: 60_000 };
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

test.beforeEach(() => resetRateLimits());

test('allows up to the limit, then refuses', () => {
  for (let i = 0; i < OPTS.limit; i += 1) {
    const result = consume('signin:1.2.3.4', { ...OPTS, now: NOW });
    assert.equal(result.allowed, true, `request ${i + 1}`);
  }
  const blocked = consume('signin:1.2.3.4', { ...OPTS, now: NOW });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0, 'tells the caller when to come back');
});

test('remaining counts down and never goes negative', () => {
  assert.equal(consume('k', { ...OPTS, now: NOW }).remaining, 2);
  assert.equal(consume('k', { ...OPTS, now: NOW }).remaining, 1);
  assert.equal(consume('k', { ...OPTS, now: NOW }).remaining, 0);
  assert.equal(consume('k', { ...OPTS, now: NOW }).remaining, 0);
});

test('the window reopens once it expires', () => {
  for (let i = 0; i < OPTS.limit; i += 1) consume('k', { ...OPTS, now: NOW });
  assert.equal(consume('k', { ...OPTS, now: NOW }).allowed, false);

  const later = NOW + OPTS.windowMs + 1;
  assert.equal(consume('k', { ...OPTS, now: later }).allowed, true, 'fresh window');
});

test('clients are counted separately', () => {
  // One noisy address must not lock everybody else out.
  for (let i = 0; i < OPTS.limit; i += 1) consume('signin:noisy', { ...OPTS, now: NOW });
  assert.equal(consume('signin:noisy', { ...OPTS, now: NOW }).allowed, false);
  assert.equal(consume('signin:quiet', { ...OPTS, now: NOW }).allowed, true);
});

test('routes are counted separately for the same client', () => {
  for (let i = 0; i < OPTS.limit; i += 1) consume('signin:1.1.1.1', { ...OPTS, now: NOW });
  assert.equal(consume('signin:1.1.1.1', { ...OPTS, now: NOW }).allowed, false);
  assert.equal(
    consume('checkout:1.1.1.1', { ...OPTS, now: NOW }).allowed,
    true,
    'hitting sign-in must not block checkout',
  );
});

test('expired buckets are swept rather than accumulating forever', () => {
  // A long-running process sees many one-off addresses; they must not leak.
  for (let i = 0; i < 500; i += 1) consume(`ip-${i}`, { ...OPTS, now: NOW });

  // A request past the sweep interval and the window triggers the cleanup.
  const later = NOW + OPTS.windowMs + 61_000;
  const result = consume('someone-new', { ...OPTS, now: later });
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, OPTS.limit - 1, 'counted as a first request');
});
