/**
 * Fixed-window rate limiting, in memory.
 *
 * Deliberately dependency-free and per-process. That is honest rather than ideal:
 * with two instances behind a load balancer each gets its own counter, so the
 * effective limit doubles. For the endpoints protected here — sign-in and
 * checkout — that is fine, because the point is to stop one client hammering a
 * route, not to enforce an exact global quota. Move to Redis when there is a
 * second instance *and* a reason to care about the exact number.
 *
 * Chosen over a sliding window because the memory cost is one integer per key
 * rather than a timestamp list, and the failure mode (a burst straddling a window
 * boundary) is harmless for these routes.
 */

const buckets = new Map();

/** Drop expired buckets so a long-running process does not grow unbounded. */
function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

export function consume(key, { limit, windowMs, now = Date.now() }) {
  if (now - lastSweep > SWEEP_INTERVAL_MS) {
    sweep(now);
    lastSweep = now;
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
}

/** Test seam; also useful if a process wants a clean slate. */
export function resetRateLimits() {
  buckets.clear();
  lastSweep = 0;
}

/**
 * Identify the caller. Behind a proxy the socket address is the load balancer, so
 * the first x-forwarded-for hop is used — spoofable in principle, but the header
 * is rewritten by the platform's own proxy in the deployments this targets.
 */
export function clientKey(c) {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return c.req.header('cf-connecting-ip') || c.env?.remoteAddr || 'unknown';
}

/**
 * Hono middleware.
 * @param {{name: string, limit: number, windowMs: number}} options
 */
export function rateLimit({ name, limit, windowMs }) {
  return async (c, next) => {
    const key = `${name}:${clientKey(c)}`;
    const result = consume(key, { limit, windowMs });

    if (!result.allowed) {
      c.header('retry-after', String(result.retryAfterSeconds));
      return c.json(
        { error: 'Too many requests — wait a moment and try again.' },
        429,
      );
    }

    c.header('x-ratelimit-remaining', String(result.remaining));
    await next();
  };
}
