/**
 * Central environment configuration. Read once; every server module imports
 * from here instead of touching process.env directly.
 */
const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name, fallbackForDev) {
  const v = env[name];
  if (v) return v;
  if (!isProd && fallbackForDev !== undefined) return fallbackForDev;
  throw new Error(`Missing required environment variable ${name}`);
}

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  /** Public base URL, e.g. https://taash.nezden.com (no trailing slash). */
  get appUrl() { return (env.APP_URL || env.AUTH_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''); },
  get secureCookies() { return this.appUrl.startsWith('https://'); },
  get authSecret() { return required('AUTH_SECRET', 'dev-only-insecure-secret-change-me-0123456789'); },
  get databaseUrl() { return required('DATABASE_URL', 'postgres://taash:taash@localhost:5432/taash'); },
  dbPoolMax: Number(env.DB_POOL_MAX || 8),
  logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  /** Email: Brevo's API first, Gmail (via nodemailer and an app password) as the fallback. */
  mail: {
    brevoApiKey: env.BREVO_API_KEY || '',
    from: env.MAIL_FROM || env.GMAIL_USER || '',
    fromName: env.MAIL_FROM_NAME || 'Taash',
    gmailUser: env.GMAIL_USER || '',
    gmailAppPassword: (env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, ''),   // Google shows it in groups of four
  },
  /** Native app: push notifications through Expo, and the oldest app version the API still serves. */
  push: {
    get enabled() { return env.PUSH_NOTIFICATIONS !== 'off'; },
    get expoAccessToken() { return env.EXPO_ACCESS_TOKEN || ''; },
  },
  get mobileMinVersion() { return env.MOBILE_MIN_VERSION || null; },
};
