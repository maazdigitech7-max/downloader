'use strict';

const { Sealer } = require('./seal');
const h = require('./http');

const COOKIE = 'sid';

/**
 * Stateless sessions for serverless hosting.
 * The Instagram access token lives in an encrypted, HttpOnly cookie: the browser stores it
 * but cannot read it. Nothing is kept on the server between requests.
 * Trade-off: a session cannot be revoked server-side, but it expires with the token (~1 hour).
 */
class SessionManager {
  constructor({ secret, secure }) {
    this.sealer = new Sealer(secret);
    this.secure = secure;
  }

  create(res, { accessToken, userId, username, expiresAt }) {
    const value = this.sealer.seal('session', { t: accessToken, u: userId, n: username }, expiresAt);
    h.setCookie(res, COOKIE, value, { maxAgeSeconds: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)), secure: this.secure });
  }

  /** @returns {{accessToken,userId,username,expiresAt}|null} */
  get(req) {
    const raw = h.parseCookies(req.headers.cookie)[COOKIE];
    const opened = raw ? this.sealer.open('session', raw) : null;
    if (!opened) return null;
    const { data, expiresAt } = opened;
    return { accessToken: data.t, userId: data.u, username: data.n, expiresAt };
  }

  destroy(res) {
    h.setCookie(res, COOKIE, '', { maxAgeSeconds: 0, secure: this.secure });
  }

  /** Opaque, tamper-proof handle for one downloadable item, bound to this user. */
  sealItem(session, item) {
    return this.sealer.seal('item', { ...item, u: session.userId }, session.expiresAt);
  }

  openItem(session, token) {
    const opened = this.sealer.open('item', token);
    return opened && opened.data.u === session.userId ? opened.data : null;
  }
}

module.exports = { SessionManager };
