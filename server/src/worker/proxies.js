/**
 * Proxy selection, per country.
 *
 * Providers split into two camps. Some sell one rotating endpoint and encode the
 * country in the username (`user-country-US`). Others — proxy-cheap among them —
 * sell a separate `host:port:user:pass` per location, so the country lives in
 * *which endpoint you dial*, not in the credentials.
 *
 * This supports the second shape as the primary one, because that is what we are
 * actually buying, and keeps the username-template form as a fallback so a
 * provider switch does not mean a rewrite.
 *
 * Configure one environment variable per country:
 *
 *   PROXY_US=1.2.3.4:8000:user:pass
 *   PROXY_GB=user:pass@5.6.7.8:8000
 *   PROXY_DEFAULT=http://user:pass@9.10.11.12:8000
 *
 * All three notations above are accepted, because every dashboard prints a
 * different one and retyping them by hand is how a digit gets dropped.
 */

/**
 * @returns {{server: string, username?: string, password?: string}|null}
 */
export function parseProxy(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();

  // http://user:pass@host:port
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (!url.hostname || !url.port) return null;
      return {
        server: `${url.protocol}//${url.hostname}:${url.port}`,
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
      };
    } catch {
      return null;
    }
  }

  // user:pass@host:port
  if (raw.includes('@')) {
    const at = raw.lastIndexOf('@');
    const credentials = raw.slice(0, at);
    const address = raw.slice(at + 1);
    const [host, port] = address.split(':');
    const separator = credentials.indexOf(':');
    if (!host || !port || separator < 0) return null;
    return {
      server: `http://${host}:${port}`,
      username: credentials.slice(0, separator),
      password: credentials.slice(separator + 1),
    };
  }

  // host:port:user:pass — the shape proxy-cheap prints. Split from the left only
  // three times, so a colon inside the password survives.
  const parts = raw.split(':');
  if (parts.length === 2) {
    const [host, port] = parts;
    return host && port ? { server: `http://${host}:${port}` } : null;
  }
  if (parts.length >= 4) {
    const [host, port, username] = parts;
    const password = parts.slice(3).join(':');
    if (!host || !port) return null;
    return { server: `http://${host}:${port}`, username, password };
  }

  return null;
}

/** Country codes we will look for a dedicated endpoint for. */
export const countryEnvKey = (country) =>
  `PROXY_${String(country || 'default').toUpperCase().replace(/[^A-Z0-9]/g, '')}`;

/**
 * Pick the proxy for a country.
 *
 * Falls back deliberately rather than silently: an unconfigured country uses
 * PROXY_DEFAULT if there is one, and `usedFallback` says so, because a scan that
 * quietly ran from the wrong country would be recorded as that country's ranking
 * and be wrong in a way nobody could see.
 */
export function proxyForCountry(country, env = process.env) {
  const exact = parseProxy(env[countryEnvKey(country)]);
  if (exact) return { proxy: exact, country, usedFallback: false };

  const fallback = parseProxy(env.PROXY_DEFAULT);
  if (fallback) return { proxy: fallback, country, usedFallback: true };

  // Legacy single-endpoint form, for providers that encode country in the user.
  if (env.PROXY_HOST) {
    const template = env.PROXY_USERNAME_TEMPLATE || env.PROXY_USERNAME || '';
    const username = template
      .replace('{country}', country || 'any')
      .replace('{session}', Math.random().toString(36).slice(2, 10));
    return {
      proxy: {
        server: `http://${env.PROXY_HOST}:${env.PROXY_PORT || 8080}`,
        username: username || undefined,
        password: env.PROXY_PASSWORD || undefined,
      },
      country,
      usedFallback: false,
    };
  }

  return { proxy: null, country, usedFallback: false };
}

/** Which countries have a dedicated endpoint configured. */
export function configuredCountries(env = process.env) {
  return Object.keys(env)
    .filter((key) => /^PROXY_[A-Z0-9]{2,3}$/.test(key) && key !== 'PROXY_DEFAULT')
    .filter((key) => parseProxy(env[key]))
    .map((key) => key.slice('PROXY_'.length).toLowerCase())
    .sort();
}
