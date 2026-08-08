/**
 * Per-country proxying, inside the user's own browser.
 *
 * Server-side scanning was defeated by Fiverr's bot protection — verified across
 * six runs, including a residential IP that browses Fiverr daily without a
 * challenge. The extension does not have that problem, because it is a real
 * browser being used normally. So the scan stays here, and only the *route*
 * changes when someone asks for a different country's rankings.
 *
 * The important restraint: Chrome's proxy setting is browser-wide, and quietly
 * pushing somebody's banking session through a third-party proxy would be
 * indefensible. A PAC script scopes it to Fiverr alone, and it is cleared the
 * moment a scan finishes.
 *
 * Pure and DOM-free so the rules can be tested without a browser.
 */

export const PROXY_KEY = 'proxies';

/** Only these hosts ever leave through the proxy. Everything else stays direct. */
export const PROXIED_HOSTS = ['fiverr.com', 'www.fiverr.com'];

/**
 * Accepts the notations proxy dashboards actually print, so credentials can be
 * pasted rather than retyped into four separate boxes.
 *
 *   1.2.3.4:8000:user:pass
 *   user:pass@1.2.3.4:8000
 *   http://user:pass@1.2.3.4:8000
 *
 * @returns {{host:string, port:number, username?:string, password?:string}|null}
 */
export function parseProxyEntry(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();

  const build = (host, port, username, password) => {
    const parsed = Number(port);
    if (!host || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
    return { host, port: parsed, username: username || undefined, password: password || undefined };
  };

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return build(
        url.hostname,
        url.port,
        url.username ? decodeURIComponent(url.username) : undefined,
        url.password ? decodeURIComponent(url.password) : undefined,
      );
    } catch {
      return null;
    }
  }

  if (raw.includes('@')) {
    const at = raw.lastIndexOf('@');
    const credentials = raw.slice(0, at);
    const [host, port] = raw.slice(at + 1).split(':');
    const separator = credentials.indexOf(':');
    if (separator < 0) return null;
    return build(host, port, credentials.slice(0, separator), credentials.slice(separator + 1));
  }

  const parts = raw.split(':');
  if (parts.length === 2) return build(parts[0], parts[1]);
  // Split three times only, so a colon inside the password survives.
  if (parts.length >= 4) return build(parts[0], parts[1], parts[2], parts.slice(3).join(':'));
  return null;
}

/**
 * A PAC script that sends Fiverr through the proxy and everything else direct.
 *
 * Written as a string because that is what chrome.proxy takes. `shExpMatch` on an
 * explicit host list rather than a wildcard: a broad pattern that accidentally
 * matched more than intended would silently reroute unrelated browsing.
 */
export function buildPacScript(proxy) {
  const endpoint = `PROXY ${proxy.host}:${proxy.port}`;
  const hosts = JSON.stringify(PROXIED_HOSTS);
  return `function FindProxyForURL(url, host) {
  var proxied = ${hosts};
  host = host.toLowerCase();
  for (var i = 0; i < proxied.length; i++) {
    if (host === proxied[i] || host.endsWith("." + proxied[i])) {
      return ${JSON.stringify(endpoint)};
    }
  }
  return "DIRECT";
}`;
}

/**
 * The chrome.proxy config for a gateway session issued by the API.
 *
 * The session names our gateway, not the upstream proxy — the customer never
 * holds the real credentials, because extension storage is readable by whoever
 * is running it.
 */
export function proxySettingsForSession(session) {
  if (!session?.host || !session?.port) return null;
  return {
    mode: 'pac_script',
    pacScript: {
      data: buildPacScript({ host: session.host, port: session.port }),
      // Never silently fall back to direct: a scan that quietly used the user's
      // own address would report their local rankings as another country's.
      mandatory: true,
    },
  };
}

export function proxyFor(country, store) {
  const key = String(country || '').toLowerCase();
  if (!key || key === 'default') return null;
  const entry = (store || {})[key];
  return entry ? parseProxyEntry(entry.raw ?? entry) : null;
}

/** Countries with a usable proxy configured, for the picker. */
export function configuredCountries(store) {
  return Object.entries(store || {})
    .filter(([, entry]) => parseProxyEntry(entry?.raw ?? entry))
    .map(([code]) => code.toLowerCase())
    .sort();
}

/**
 * Whether a scan may claim to be measuring a country's rankings.
 *
 * Running a "New Zealand" scan through no proxy would record the user's own
 * location as New Zealand's rankings — wrong in a way nobody could detect
 * afterwards, which is worse than refusing.
 */
export function canScanCountry(country, store) {
  if (!country || country === 'default') return { allowed: true };
  if (proxyFor(country, store)) return { allowed: true };
  return {
    allowed: false,
    reason: `No proxy configured for ${country.toUpperCase()}. Add one in Menu → Countries.`,
  };
}

/**
 * How one country should appear in the picker.
 *
 * Three states, and the distinction between the last two is what makes the
 * feature sellable. A country we have no proxy for cannot be scanned by anyone,
 * so it is inert. A country we *do* have a proxy for is a thing the user could
 * have today by paying — so it stays selectable, and picking it is what surfaces
 * the offer. Disabling it instead is a dead end: the strongest moment of intent
 * we ever get, spent on a greyed-out row.
 *
 * `selectable` never means scannable. `locked` countries are refused at start,
 * and the server refuses them again; this only decides what the picker allows.
 */
export function countryChoiceState(code, { configured, unlocked }) {
  if (!code || code === 'default') {
    return { selectable: true, locked: false, available: true, suffix: '' };
  }
  const available = (configured || []).includes(code);
  if (!available) {
    return { selectable: false, locked: false, available: false, suffix: 'coming soon' };
  }
  if (!unlocked) {
    return { selectable: true, locked: true, available: true, suffix: 'Business plan' };
  }
  return { selectable: true, locked: false, available: true, suffix: '' };
}

/**
 * The country the picker should show, given what the user last chose.
 *
 * A locked choice is kept rather than snapped back to "my location": the user
 * asked for Germany, and answering that by silently selecting something else
 * loses both the intent and the chance to explain why it costs money.
 */
export function resolveCountryChoice(chosen, { configured, unlocked }) {
  const code = String(chosen || 'default').toLowerCase();
  return countryChoiceState(code, { configured, unlocked }).selectable ? code : 'default';
}

/** Country codes offered in the picker, with display names. */
export const COUNTRIES = [
  { code: 'default', name: 'My location' },
  { code: 'us', name: 'United States' },
  { code: 'gb', name: 'United Kingdom' },
  { code: 'au', name: 'Australia' },
  { code: 'nz', name: 'New Zealand' },
  { code: 'ca', name: 'Canada' },
  { code: 'de', name: 'Germany' },
  { code: 'fr', name: 'France' },
  { code: 'in', name: 'India' },
  { code: 'sg', name: 'Singapore' },
];

export const countryName = (code) =>
  COUNTRIES.find((c) => c.code === code)?.name || String(code || '').toUpperCase();
