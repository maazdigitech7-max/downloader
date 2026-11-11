'use strict';

const { AppError } = require('./errors');
const { parseInstagramUrl } = require('../public/js/validators');

const MEDIA_FIELDS =
  'id,media_type,media_url,thumbnail_url,permalink,' + 'children{id,media_type,media_url,thumbnail_url}';
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/**
 * Client for the official "Instagram API with Instagram Login" (Business Login).
 * It can only read media belonging to the account that authorised the app.
 * No scraping, no private endpoints, no cookies.
 */
class InstagramClient {
  constructor(cfg, fetchImpl = globalThis.fetch) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return this.cfg.enabled;
  }

  buildAuthUrl(state) {
    const url = new URL(this.cfg.authUrl);
    url.search = new URLSearchParams({
      client_id: this.cfg.appId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: this.cfg.scope,
      state,
    }).toString();
    return url.toString();
  }

  async request(url, init = {}) {
    let res;
    try {
      res = await this.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch {
      throw new AppError(502, 'INSTAGRAM_UNREACHABLE', 'Could not reach Instagram. Please try again shortly.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok || data?.error || data?.error_type) {
      const code = data?.error?.code ?? data?.code;
      console.error('[instagram] API error', res.status, code, data?.error?.message || data?.error_message || '');
      if (code === 190 || res.status === 401) {
        throw new AppError(401, 'AUTH_EXPIRED', 'Your Instagram connection has expired. Please reconnect.');
      }
      if (RATE_LIMIT_CODES.has(code) || res.status === 429) {
        throw new AppError(429, 'INSTAGRAM_RATE_LIMIT', 'Instagram is rate limiting requests. Please try again in a few minutes.');
      }
      throw new AppError(502, 'INSTAGRAM_API_ERROR', 'Instagram rejected the request. Please try again later.');
    }
    return data;
  }

  /** Exchange the OAuth code for a short-lived (1 hour) user access token. */
  async exchangeCode(code) {
    const body = new URLSearchParams({
      client_id: this.cfg.appId,
      client_secret: this.cfg.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: this.cfg.redirectUri,
      code: String(code).replace(/#_$/, ''),
    });
    const data = await this.request(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const token = data?.access_token ?? data?.data?.[0]?.access_token;
    if (!token) throw new AppError(502, 'INSTAGRAM_API_ERROR', 'Instagram did not return an access token.');
    return { accessToken: token, expiresAt: Date.now() + 55 * 60 * 1000 };
  }

  graphUrl(path, params) {
    const url = new URL(`${this.cfg.graphBase}/${this.cfg.apiVersion}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  }

  async getProfile(accessToken) {
    const data = await this.request(this.graphUrl('me', { fields: 'user_id,username', access_token: accessToken }));
    return { userId: String(data.user_id ?? data.id ?? ''), username: String(data.username ?? '') };
  }

  /**
   * Look through the connected account's own media for the given shortcode.
   * @returns normalised media or null if it is not in this account's recent media
   */
  async findOwnMedia(accessToken, shortcode) {
    const graphHost = new URL(this.cfg.graphBase).host;
    let next = this.graphUrl('me/media', { fields: MEDIA_FIELDS, limit: '50', access_token: accessToken }).toString();
    for (let page = 0; next && page < this.cfg.maxPages; page += 1) {
      const data = await this.request(next);
      for (const raw of data.data || []) {
        const parsed = parseInstagramUrl(raw.permalink || '');
        if (parsed.ok && parsed.shortcode === shortcode) return normalise(raw);
      }
      const candidate = data.paging?.next;
      // Only follow pagination links that stay on the Instagram Graph host.
      next = candidate && new URL(candidate).host === graphHost ? candidate : null;
    }
    return null;
  }
}

function normalise(raw) {
  const one = (m) => ({
    id: String(m.id),
    mediaType: m.media_type === 'VIDEO' ? 'VIDEO' : 'IMAGE',
    mediaUrl: m.media_url || null,
    thumbnailUrl: m.thumbnail_url || null,
  });
  const children = raw.media_type === 'CAROUSEL_ALBUM' ? (raw.children?.data || []).map(one) : [];
  return { id: String(raw.id), mediaType: raw.media_type, permalink: raw.permalink, ...one(raw), children };
}

module.exports = { InstagramClient };
