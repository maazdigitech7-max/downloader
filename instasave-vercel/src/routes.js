'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { AppError } = require('./errors');
const h = require('./http');
const { sniff, MediaService } = require('./media');
const { parseInstagramUrl } = require('../public/js/validators');

const STATE_COOKIE = 'oauth_state';
const UPSTREAM_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

function sanitizeFilename(name) {
  const cleaned = String(name)
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'image';
}
const stripExt = (name) => name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'image';

/**
 * Builds the HTTP surface of the app. Handlers use only Node-native req/res APIs
 * (plus req.params), so they run on Express and are testable without it.
 * Nothing is stored on the server: sessions are encrypted cookies, uploads are processed in memory.
 */
function createRoutes({ config, sessions, instagram, media }) {
  const secure = config.isProd;
  const apiLimit = h.rateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.api });
  const heavyLimit = h.rateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.heavy });
  const middleware = [h.securityHeaders({ isProd: config.isProd }), h.originCheck(config.baseUrl)];

  /* ------------------------------ config & session ------------------------------ */

  function getConfig(req, res) {
    h.sendJson(res, 200, {
      appName: config.appName,
      contactEmail: config.contactEmail || null,
      instagram: { enabled: instagram.enabled },
      upload: { maxMb: Math.floor(config.upload.maxBytes / 1048576) },
      conversions: media.capabilities(),
    });
  }

  function getSession(req, res) {
    const s = sessions.get(req);
    h.sendJson(res, 200, s ? { connected: true, username: s.username, expiresAt: new Date(s.expiresAt).toISOString() } : { connected: false });
  }

  function logout(req, res) {
    sessions.destroy(res);
    h.sendJson(res, 200, { ok: true });
  }

  /* --------------------------- Instagram OAuth (official) -------------------------- */

  function authStart(req, res) {
    if (!instagram.enabled) return h.redirect(res, '/?auth_error=not_configured');
    const state = h.randomToken(24);
    h.setCookie(res, STATE_COOKIE, state, { maxAgeSeconds: 600, secure });
    h.redirect(res, instagram.buildAuthUrl(state));
  }

  async function authCallback(req, res) {
    const q = h.getQuery(req);
    const expected = h.parseCookies(req.headers.cookie)[STATE_COOKIE];
    h.setCookie(res, STATE_COOKIE, '', { maxAgeSeconds: 0, secure });
    if (!instagram.enabled) return h.redirect(res, '/?auth_error=not_configured');
    if (q.get('error')) return h.redirect(res, '/?auth_error=denied');
    if (!expected || !q.get('state') || !h.safeEqual(expected, q.get('state')) || !q.get('code')) {
      return h.redirect(res, '/?auth_error=state');
    }
    try {
      const { accessToken, expiresAt } = await instagram.exchangeCode(q.get('code'));
      const profile = await instagram.getProfile(accessToken);
      sessions.create(res, { accessToken, expiresAt, ...profile });
      h.redirect(res, '/?connected=1');
    } catch (err) {
      console.error('[auth] callback failed:', err.message);
      h.redirect(res, '/?auth_error=failed');
    }
  }

  /* ------------------------------ Instagram media ------------------------------- */

  async function resolve(req, res) {
    const body = await h.readJson(req);
    const parsed = parseInstagramUrl(body.url);
    if (!parsed.ok) throw new AppError(400, parsed.code, parsed.message);
    if (!instagram.enabled) {
      throw new AppError(503, 'INSTAGRAM_NOT_CONFIGURED', 'Instagram connection is not set up on this server. You can still use the image converter.');
    }
    const session = sessions.get(req);
    if (!session) {
      throw new AppError(401, 'AUTH_REQUIRED', 'Connect your Instagram account first. Only media from the account you connect can be downloaded.');
    }

    const found = await instagram.findOwnMedia(session.accessToken, parsed.shortcode);
    if (!found) {
      throw new AppError(
        404,
        'NOT_AVAILABLE',
        `This link was not found among the most recent posts of @${session.username}. InstaSave can only download media from the account you connected, and the official API does not provide access to anyone else's posts.`
      );
    }

    const parts = found.children.length ? found.children : [found];
    const items = [];
    parts.forEach((part, index) => {
      if (!part.mediaUrl) return; // Instagram omits media_url for e.g. copyrighted audio
      const id = sessions.sealItem(session, {
        m: part.mediaUrl,
        t: part.thumbnailUrl,
        b: `instagram-${parsed.shortcode}${parts.length > 1 ? `-${index + 1}` : ''}`,
      });
      items.push({
        id: crypto.createHash('sha256').update(id).digest('hex').slice(0, 12),
        index: index + 1,
        mediaType: part.mediaType,
        formats: [part.mediaType === 'VIDEO' ? 'MP4' : 'JPG'],
        previewUrl: `/api/ig/item/${id}/media`,
        posterUrl: part.thumbnailUrl ? `/api/ig/item/${id}/thumb` : null,
        downloadUrl: `/api/ig/item/${id}/media?download=1`,
      });
    });
    if (!items.length) {
      throw new AppError(422, 'MEDIA_UNAVAILABLE', 'Instagram did not provide a downloadable file for this post (for example, because it contains copyrighted audio).');
    }
    h.sendJson(res, 200, { type: parsed.type, carousel: found.children.length > 1, shortcode: parsed.shortcode, items });
  }

  /** Streams an item of the connected account through our server (keeps the token and CDN URLs private). */
  async function igProxy(req, res) {
    const session = sessions.get(req);
    if (!session) throw new AppError(401, 'AUTH_REQUIRED', 'Connect your Instagram account first.');
    const item = sessions.openItem(session, req.params.id);
    if (!item) throw new AppError(404, 'NOT_FOUND', 'This item has expired. Please look up the link again.');
    const isThumb = req.params.variant === 'thumb';
    const target = isThumb ? item.t || item.m : item.m;
    if (!config.isAllowedMediaUrl(target)) {
      throw new AppError(502, 'BLOCKED_HOST', 'The media location was rejected for security reasons.');
    }

    const headers = {};
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;

    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const connectTimer = setTimeout(() => ac.abort(), 15000);
    let upstream;
    try {
      upstream = await fetch(target, { headers, redirect: 'manual', signal: ac.signal });
    } catch {
      throw new AppError(502, 'UPSTREAM_ERROR', 'Could not download the file from Instagram.');
    } finally {
      clearTimeout(connectTimer);
    }
    const type = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = UPSTREAM_TYPES[type];
    if ((upstream.status !== 200 && upstream.status !== 206) || !ext || !upstream.body) {
      upstream.body?.cancel().catch(() => {});
      throw new AppError(502, 'UPSTREAM_ERROR', 'Instagram did not return a valid media file.');
    }

    const download = h.getQuery(req).get('download') === '1';
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', type);
    const encoded = upstream.headers.get('content-encoding');
    for (const name of ['content-range', 'accept-ranges', ...(encoded ? [] : ['content-length'])]) {
      const v = upstream.headers.get(name);
      if (v) res.setHeader(name, v);
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', h.contentDisposition(download ? 'attachment' : 'inline', `${item.b}${isThumb ? '-thumb' : ''}.${ext}`));
    await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
  }

  /* ------------------------------ image converter ----------------------------- */

  /** POST raw image bytes -> converted image bytes. Nothing is stored. */
  async function convert(req, res) {
    const format = (h.getQuery(req).get('format') || '').toLowerCase();
    const out = MediaService.outputInfo(format);
    if (!out) throw new AppError(400, 'UNSUPPORTED_FORMAT', 'Choose JPG, PNG or WebP as the output format.');

    let name = 'image';
    try {
      name = decodeURIComponent(String(req.headers['x-filename'] || 'image'));
    } catch {
      /* keep default */
    }
    name = sanitizeFilename(name);

    const buffer = await h.readBody(req, config.upload.maxBytes);
    const type = sniff(buffer.subarray(0, 64));
    if (!type) throw new AppError(415, 'UNSUPPORTED_FILE', 'Unsupported file. Upload a JPG, PNG, WebP or GIF image.');
    if (type.kind !== 'image') {
      throw new AppError(415, 'VIDEO_NOT_SUPPORTED', 'Video files cannot be converted on this hosting. Videos from your own Instagram account can be downloaded with the link tab.');
    }

    const result = await media.convert(buffer, format);
    res.statusCode = 200;
    res.setHeader('Content-Type', out.mime);
    res.setHeader('Content-Length', String(result.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Content-Disposition', h.contentDisposition('attachment', `${stripExt(name)}.${out.ext}`));
    res.end(result);
  }

  const w = h.wrap;
  const routes = [
    { method: 'get', path: '/api/config', middleware: [apiLimit], handler: w(getConfig) },
    { method: 'get', path: '/api/session', middleware: [apiLimit], handler: w(getSession) },
    { method: 'post', path: '/api/logout', middleware: [apiLimit], handler: w(logout) },
    { method: 'get', path: '/auth/instagram', middleware: [heavyLimit], handler: w(authStart) },
    { method: 'get', path: '/auth/instagram/callback', middleware: [heavyLimit], handler: w(authCallback) },
    { method: 'post', path: '/api/resolve', middleware: [heavyLimit], handler: w(resolve) },
    { method: 'get', path: '/api/ig/item/:id/:variant', middleware: [apiLimit], handler: w(igProxy) },
    { method: 'post', path: '/api/convert', middleware: [heavyLimit], handler: w(convert) },
  ];

  return { routes, middleware };
}

module.exports = { createRoutes, sanitizeFilename };
