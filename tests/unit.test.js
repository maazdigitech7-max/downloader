'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sniff } = require('../src/media');
const { Sealer } = require('../src/seal');
const { loadConfig, defaultIsAllowedMediaUrl } = require('../src/config');
const { sanitizeFilename } = require('../src/routes');
const { makePng, makeJpeg, makeMp4 } = require('./helpers/fixtures');

test('sniff identifies supported types by content and rejects the rest', async () => {
  assert.equal(sniff(await makePng()).ext, 'png');
  assert.equal(sniff(await makeJpeg()).ext, 'jpg');
  assert.equal(sniff(makeMp4()).ext, 'mp4');
  assert.equal(sniff(Buffer.from('GIF89a' + '\0'.repeat(20), 'latin1')).ext, 'gif');
  assert.equal(sniff(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), Buffer.alloc(8)])).ext, 'webp');
  assert.equal(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array(20).fill(0)])).ext, 'webm');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniff(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniff(Buffer.from('MZ' + '\0'.repeat(40), 'latin1')), null);
  assert.equal(sniff(Buffer.from('\0\0\0\x18ftypheic' + '\0'.repeat(20), 'latin1')), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
});

test('sealed values: round trip, tampering, wrong kind, wrong secret, expiry', () => {
  const a = new Sealer('a'.repeat(40));
  const future = Date.now() + 60000;
  const token = a.seal('session', { t: 'secret-token-123' }, future);
  assert.equal(token.includes('secret-token-123'), false, 'plaintext must not appear');
  assert.equal(Buffer.from(token, 'base64url').toString('latin1').includes('secret-token-123'), false);
  assert.deepEqual(a.open('session', token).data, { t: 'secret-token-123' });
  assert.equal(a.open('item', token), null, 'a session cookie cannot be used as an item token');
  assert.equal(new Sealer('b'.repeat(40)).open('session', token), null, 'different secret');
  const raw = Buffer.from(token, 'base64url');
  raw[raw.length - 1] ^= 1;
  assert.equal(a.open('session', raw.toString('base64url')), null, 'bit flip');
  assert.equal(a.open('session', token.slice(0, -4)), null, 'truncated');
  assert.equal(a.open('session', 'garbage'), null);
  assert.equal(a.open('session', a.seal('session', {}, Date.now() - 1)), null, 'expired');
  assert.notEqual(a.seal('session', {}, future), a.seal('session', {}, future), 'random IV');
});

test('media proxy only allows https Instagram/Facebook CDN hosts', () => {
  const ok = ['https://scontent-sin6-1.cdninstagram.com/v/t51/a.jpg', 'https://video.fbcdn.net/x.mp4', 'https://cdninstagram.com/a'];
  const bad = ['http://scontent.cdninstagram.com/a.jpg', 'https://169.254.169.254/latest/meta-data', 'https://localhost/a', 'https://evil.com/cdninstagram.com', 'https://cdninstagram.com.evil.com/a', 'https://notcdninstagram.com/a', 'https://user@scontent.cdninstagram.com/a', 'https://scontent.cdninstagram.com:8443/a', 'file:///etc/passwd', 'not a url', ''];
  ok.forEach((u) => assert.equal(defaultIsAllowedMediaUrl(u), true, u));
  bad.forEach((u) => assert.equal(defaultIsAllowedMediaUrl(u), false, u));
});

test('filenames are sanitised', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'etcpasswd');
  assert.equal(sanitizeFilename('a"b<c>d|e?.jpg'), 'abcde.jpg');
  assert.equal(sanitizeFilename('.hidden'), 'hidden');
  assert.equal(sanitizeFilename(''), 'image');
  assert.equal(sanitizeFilename('x'.repeat(500)).length, 120);
});

test('config: env-driven, Vercel hostname detection, secrets required in production', () => {
  const dev = loadConfig({});
  assert.equal(dev.instagram.enabled, false);
  assert.equal(dev.instagram.problem, 'missing_app_credentials');
  assert.equal(dev.upload.maxBytes, 4 * 1024 * 1024);

  const clamp = loadConfig({ MAX_UPLOAD_MB: '50' });
  assert.equal(clamp.upload.maxBytes, 4 * 1024 * 1024, 'never above the 4.5 MB platform limit');

  const prodNoSecret = loadConfig({ NODE_ENV: 'production', INSTAGRAM_APP_ID: '1', INSTAGRAM_APP_SECRET: 's' });
  assert.equal(prodNoSecret.instagram.enabled, false);
  assert.equal(prodNoSecret.instagram.problem, 'missing_session_secret');

  const shortSecret = loadConfig({ NODE_ENV: 'production', INSTAGRAM_APP_ID: '1', INSTAGRAM_APP_SECRET: 's', SESSION_SECRET: 'short' });
  assert.equal(shortSecret.instagram.enabled, false);

  const vercel = loadConfig({ NODE_ENV: 'production', VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'insta.vercel.app', INSTAGRAM_APP_ID: '1', INSTAGRAM_APP_SECRET: 's', SESSION_SECRET: 'z'.repeat(32) });
  assert.equal(vercel.instagram.enabled, true);
  assert.equal(vercel.baseUrl, 'https://insta.vercel.app');
  assert.equal(vercel.instagram.redirectUri, 'https://insta.vercel.app/auth/instagram/callback');
  assert.equal(vercel.trustProxy, '1');
  const custom = loadConfig({ BASE_URL: 'https://my.domain/', VERCEL_URL: 'x.vercel.app' });
  assert.equal(custom.baseUrl, 'https://my.domain');
});

test('server and browser copies of the URL validator are identical', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const a = fs.readFileSync(path.join(__dirname, '..', 'src', 'validators.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'validators.js'), 'utf8');
  assert.equal(a, b, 'copy src/validators.js to public/js/validators.js (or vice versa) after editing');
});
