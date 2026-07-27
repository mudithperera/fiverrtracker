/**
 * Environment configuration, validated once at boot.
 *
 * Failing loudly on start beats a request-time crash three days later, so every
 * required variable is checked here rather than read ad hoc across the codebase.
 */

const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'PUBLIC_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadEnv() {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'See server/.env.example.',
    );
  }

  return {
    port: Number(process.env.PORT || 8787),
    databaseUrl: required('DATABASE_URL'),
    jwtSecret: required('JWT_SECRET'),
    /** Public origin of this API, used to build the OAuth redirect URI. */
    publicUrl: required('PUBLIC_URL').replace(/\/$/, ''),

    google: {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
    },

    stripe: {
      secretKey: required('STRIPE_SECRET_KEY'),
      webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
      /**
       * Price ids are looked up per plan + interval. Missing ones simply mean that
       * option is not offered yet, so they are not required to boot.
       */
      prices: {
        pro: {
          month: process.env.STRIPE_PRICE_PRO_MONTHLY || null,
          year: process.env.STRIPE_PRICE_PRO_YEARLY || null,
        },
        business: {
          month: process.env.STRIPE_PRICE_BUSINESS_MONTHLY || null,
          year: process.env.STRIPE_PRICE_BUSINESS_YEARLY || null,
        },
      },
    },

    /**
     * Extension ids allowed to call the API. The OAuth flow redirects back to
     * https://<id>.chromiumapp.org/, so an open list here would let any extension
     * complete a sign-in against this backend.
     */
    allowedExtensionIds: (process.env.ALLOWED_EXTENSION_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),

    sessionDays: Number(process.env.SESSION_DAYS || 30),
  };
}
