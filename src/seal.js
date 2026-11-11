'use strict';

const crypto = require('node:crypto');

/**
 * Authenticated encryption (AES-256-GCM) for small JSON payloads.
 * Used instead of server-side storage, because serverless functions keep no memory between requests.
 * The browser can neither read nor forge a sealed value without SESSION_SECRET.
 */
class Sealer {
  constructor(secret) {
    this.key = crypto.createHash('sha256').update(String(secret)).digest();
  }

  seal(kind, data, expiresAt) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const plain = Buffer.from(JSON.stringify({ k: kind, e: expiresAt, d: data }), 'utf8');
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
  }

  /** @returns {{data, expiresAt}|null} null if tampered, of the wrong kind, or expired */
  open(kind, token) {
    try {
      const raw = Buffer.from(String(token), 'base64url');
      if (raw.length < 29) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      const obj = JSON.parse(plain.toString('utf8'));
      if (obj.k !== kind || typeof obj.e !== 'number' || obj.e <= Date.now()) return null;
      return { data: obj.d, expiresAt: obj.e };
    } catch {
      return null;
    }
  }
}

module.exports = { Sealer };
