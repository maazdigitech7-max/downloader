'use strict';

const crypto = require('node:crypto');
const { AppError } = require('./errors');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function redirect(res, location, status = 302) {
  res.statusCode = status;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

const getQuery = (req) => new URL(req.url, 'http://localhost').searchParams;
const clientIp = (req) => req.ip || req.socket.remoteAddress || 'unknown';
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

function setCookie(res, name, value, { maxAgeSeconds, secure }) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  attrs.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) attrs.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? [].concat(prev) : [];
  list.push(attrs.join('; '));
  res.setHeader('Set-Cookie', list);
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
function contentDisposition(type, filename) {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Read a small JSON body. Never destroys the socket so the error response can be delivered. */
function readJson(req, limit = 16 * 1024) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    return Promise.reject(
      new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.')
    );
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const done = (fn, v) => {
      if (!settled) {
        settled = true;
        fn(v);
      }
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) return done(reject, new AppError(413, 'BODY_TOO_LARGE', 'Request body is too large.'));
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        done(resolve, value);
      } catch {
        done(reject, new AppError(400, 'INVALID_JSON', 'Request body must be a JSON object.'));
      }
    });
    req.on('error', () => done(reject, new AppError(400, 'BAD_REQUEST', 'The request could not be read.')));
  });
}

/** Read a raw body into memory, up to `limit` bytes. Never destroys the socket so the error can be delivered. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      return reject(new AppError(413, 'FILE_TOO_LARGE', `File is larger than the ${Math.floor(limit / 1048576)} MB limit.`));
    }
    let size = 0;
    let settled = false;
    const chunks = [];
    const done = (fn, v) => {
      if (!settled) {
        settled = true;
        fn(v);
      }
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) return done(reject, new AppError(413, 'FILE_TOO_LARGE', `File is larger than the ${Math.floor(limit / 1048576)} MB limit.`));
      chunks.push(chunk);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks)));
    req.on('error', () => done(reject, new AppError(400, 'UPLOAD_ABORTED', 'The upload was interrupted.')));
    req.on('close', () => !req.complete && done(reject, new AppError(400, 'UPLOAD_ABORTED', 'The upload was interrupted.')));
  });
}

/** Baseline security headers + a strict CSP (no inline script/style needed by the app). */
function securityHeaders({ isProd }) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}

/** CSRF defence in depth: state-changing requests must come from our own origin. */
function originCheck(baseUrl) {
  const allowed = new URL(baseUrl).host;
  return function originCheckMiddleware(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* invalid origin falls through to rejection */
      }
      if (host !== req.headers.host && host !== allowed) {
        return sendJson(res, 403, { error: { code: 'BAD_ORIGIN', message: 'Cross-site requests are not allowed.' } });
      }
    }
    next();
  };
}

/** Small in-memory fixed-window limiter, per client IP. */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, h] of hits) if (h.resetAt <= now) hits.delete(key);
  }, windowMs);
  timer.unref();

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = clientIp(req);
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + windowMs };
      hits.set(key, h);
    }
    h.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - h.count)));
    if (h.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return sendJson(res, 429, {
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
      });
    }
    next();
  };
}

function handleError(err, req, res) {
  const known = err instanceof AppError;
  if (!known) console.error('[error]', err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = known ? err.status : 500;
  if (status === 413) res.setHeader('Connection', 'close');
  sendJson(res, status, {
    error: {
      code: known ? err.code : 'INTERNAL_ERROR',
      message: known ? err.message : 'Something went wrong on our side. Please try again.',
    },
  });
}

/** Wrap an async handler so rejections become JSON errors (Express 4 does not do this). */
const wrap = (fn) => (req, res, next) => {
  Promise.resolve()
    .then(() => fn(req, res, next))
    .catch((err) => handleError(err, req, res));
};

module.exports = {
  sendJson,
  redirect,
  getQuery,
  clientIp,
  randomToken,
  safeEqual,
  parseCookies,
  setCookie,
  contentDisposition,
  readJson,
  readBody,
  securityHeaders,
  originCheck,
  rateLimiter,
  handleError,
  wrap,
};
