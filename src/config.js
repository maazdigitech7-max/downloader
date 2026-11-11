'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

/** Load .env (Node >= 20.12). Existing environment variables always win. */
function loadDotEnv() {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Only Instagram/Facebook CDN hosts over HTTPS may be fetched by the media proxy.
 * This is the SSRF guard: URLs come from Instagram's API, and are still checked.
 */
function defaultIsAllowedMediaUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return ['cdninstagram.com', 'fbcdn.net'].some((d) => host === d || host.endsWith('.' + d));
}

function loadConfig(env = process.env) {
  const port = int(env.PORT, 3000);
  const isProd = env.NODE_ENV === 'production';
  // On Vercel the public hostname is provided automatically (without scheme).
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || '';
  const baseUrl = (env.BASE_URL || (vercelHost ? `https://${vercelHost}` : `http://localhost:${port}`)).replace(/\/+$/, '');
  const appId = (env.INSTAGRAM_APP_ID || '').trim();
  const appSecret = (env.INSTAGRAM_APP_SECRET || '').trim();
  // Encrypts the session cookie. Required in production; random per process in local dev.
  const sessionSecret = (env.SESSION_SECRET || '').trim() || (isProd ? '' : crypto.randomBytes(32).toString('hex'));
  const secretOk = sessionSecret.length >= 32;

  return {
    appName: 'InstaSave',
    isProd,
    port,
    baseUrl,
    trustProxy: (env.TRUST_PROXY ?? (env.VERCEL ? '1' : '')).trim(),
    contactEmail: (env.CONTACT_EMAIL || '').trim(),
    sessionSecret,
    instagram: {
      enabled: Boolean(appId && appSecret && secretOk),
      problem: !(appId && appSecret) ? 'missing_app_credentials' : !secretOk ? 'missing_session_secret' : null,
      appId,
      appSecret,
      redirectUri: (env.INSTAGRAM_REDIRECT_URI || `${baseUrl}/auth/instagram/callback`).trim(),
      scope: 'instagram_business_basic',
      apiVersion: env.INSTAGRAM_API_VERSION || 'v25.0',
      authUrl: 'https://www.instagram.com/oauth/authorize',
      tokenUrl: 'https://api.instagram.com/oauth/access_token',
      graphBase: 'https://graph.instagram.com',
      maxPages: int(env.INSTAGRAM_MAX_PAGES, 6),
    },
    // Vercel rejects request/response bodies above 4.5 MB, so uploads are capped just below that.
    upload: { maxBytes: Math.min(int(env.MAX_UPLOAD_MB, 4), 4) * 1024 * 1024 },
    rateLimit: { windowMs: 60 * 1000, api: int(env.RATE_LIMIT_API, 300), heavy: int(env.RATE_LIMIT_HEAVY, 30) },
    isAllowedMediaUrl: defaultIsAllowedMediaUrl,
  };
}

module.exports = { loadConfig, loadDotEnv, defaultIsAllowedMediaUrl };
