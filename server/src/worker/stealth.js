/**
 * Making a headless browser look like a normal one.
 *
 * Fiverr fronts with PerimeterX, which scores a visitor on both IP reputation and
 * browser fingerprint. A datacentre IP running headless Chromium fails on both at
 * once, so the first block tells you nothing about which mattered. Everything here
 * addresses the fingerprint half, leaving the IP as the only remaining variable.
 *
 * Honest limits: this defeats the cheap, well-documented checks. PerimeterX also
 * scores canvas and WebGL noise, timing, and mouse and scroll behaviour, and it
 * updates faster than any hand-rolled patch set. Treat this as raising the floor,
 * not as a guarantee.
 */

/** Country → plausible locale, timezone and languages, so they agree with the exit IP. */
const LOCALES = {
  us: { locale: 'en-US', timezoneId: 'America/New_York', languages: ['en-US', 'en'] },
  gb: { locale: 'en-GB', timezoneId: 'Europe/London', languages: ['en-GB', 'en'] },
  uk: { locale: 'en-GB', timezoneId: 'Europe/London', languages: ['en-GB', 'en'] },
  ca: { locale: 'en-CA', timezoneId: 'America/Toronto', languages: ['en-CA', 'en'] },
  au: { locale: 'en-AU', timezoneId: 'Australia/Sydney', languages: ['en-AU', 'en'] },
  de: { locale: 'de-DE', timezoneId: 'Europe/Berlin', languages: ['de-DE', 'de', 'en'] },
  fr: { locale: 'fr-FR', timezoneId: 'Europe/Paris', languages: ['fr-FR', 'fr', 'en'] },
  nz: { locale: 'en-NZ', timezoneId: 'Pacific/Auckland', languages: ['en-NZ', 'en'] },
  ie: { locale: 'en-IE', timezoneId: 'Europe/Dublin', languages: ['en-IE', 'en'] },
  sg: { locale: 'en-SG', timezoneId: 'Asia/Singapore', languages: ['en-SG', 'en'] },
  za: { locale: 'en-ZA', timezoneId: 'Africa/Johannesburg', languages: ['en-ZA', 'en'] },
  nl: { locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', languages: ['nl-NL', 'nl', 'en'] },
  es: { locale: 'es-ES', timezoneId: 'Europe/Madrid', languages: ['es-ES', 'es', 'en'] },
  in: { locale: 'en-IN', timezoneId: 'Asia/Kolkata', languages: ['en-IN', 'en'] },
  lk: { locale: 'en-US', timezoneId: 'Asia/Colombo', languages: ['en-US', 'en'] },
  default: { locale: 'en-US', timezoneId: 'America/New_York', languages: ['en-US', 'en'] },
};

/** Countries with a coherent identity of their own, rather than the fallback. */
export const KNOWN_COUNTRIES = Object.keys(LOCALES).filter((c) => c !== 'default');

export function localeFor(country) {
  return LOCALES[String(country || '').toLowerCase()] || LOCALES.default;
}

/**
 * Launch flags.
 *
 * `AutomationControlled` is the one that matters most: without it Chromium
 * advertises itself as automated in the CDP layer and `navigator.webdriver` is
 * true no matter what the page script does afterwards.
 */
export const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

/**
 * Build a user agent from the browser's *own* version.
 *
 * Playwright's Chromium reports "HeadlessChrome/141.0.0.0", which is a one-line
 * giveaway. Hardcoding some other Chrome version is worse than it looks though:
 * the claimed version then disagrees with the engine's actual behaviour and with
 * the Client Hints headers, which is itself detectable. Deriving it from
 * browser.version() keeps the story consistent.
 */
/**
 * Pull the major version out of whatever Playwright reports — the shape varies
 * ("141.0.7390.54", "HeadlessChrome/141.0.7390.54"), so match the first run of
 * digits rather than splitting on a separator that may not be there.
 */
export function majorVersion(browserVersion, fallback = '141') {
  const match = String(browserVersion || '').match(/(\d+)/);
  return match ? match[1] : fallback;
}

export function userAgentFrom(browserVersion, platform = 'Windows NT 10.0; Win64; x64') {
  return (
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${majorVersion(browserVersion)}.0.0.0 Safari/537.36`
  );
}

/** Client Hints must agree with the user agent, or the mismatch is the signal. */
export function clientHintHeaders(browserVersion) {
  const major = majorVersion(browserVersion);
  return {
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'upgrade-insecure-requests': '1',
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  };
}

/**
 * Runs before any page script. Patches the properties whose absence or default
 * value marks an automated browser.
 *
 * Deliberately conservative: each patch mimics what a real Chrome actually
 * reports. Over-patching is its own tell — a browser claiming forty plugins is as
 * suspicious as one claiming none.
 */
export function stealthInitScript({ languages }) {
  return `(() => {
    const langs = ${JSON.stringify(languages)};

    // Set by Chromium whenever it is driven by automation.
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });

    // Headless reports an empty plugin array; real Chrome ships these three.
    const makePlugins = () => {
      const data = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
      ];
      const list = data.map((p) => ({ ...p, description: 'Portable Document Format', length: 1 }));
      Object.setPrototypeOf(list, PluginArray.prototype);
      return list;
    };
    Object.defineProperty(Navigator.prototype, 'plugins', {
      get: makePlugins,
      configurable: true,
    });

    Object.defineProperty(Navigator.prototype, 'languages', {
      get: () => langs,
      configurable: true,
    });

    // Real Chrome exposes window.chrome; headless does not.
    if (!window.chrome) {
      window.chrome = { runtime: {}, app: { isInstalled: false } };
    }

    // Headless resolves notification permission to 'denied' while the permission
    // API reports 'default' — an inconsistency that is trivially checked.
    const query = window.navigator.permissions?.query;
    if (query) {
      window.navigator.permissions.query = (params) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission, onchange: null })
          : query.call(window.navigator.permissions, params);
    }

    // A headless container reports 0 for both, which no real device does.
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
      get: () => 8,
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, 'deviceMemory', {
      get: () => 8,
      configurable: true,
    });
  })();`;
}
