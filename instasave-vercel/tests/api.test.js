'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startApp } = require('./helpers/harness');
const { startFakeInstagram } = require('./helpers/fakeInstagram');
const { makePng, makeJpeg, makeMp4 } = require('./helpers/fixtures');
const { sniff } = require('../src/media');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const post = (app, path, body, headers = {}) => fetch(app.base + path, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
const cookieOf = (res, name) => {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(name + '='));
  return line ? line.split(';')[0] : null;
};
const convert = (app, buf, format, name = 'file.bin') =>
  fetch(`${app.base}/api/convert${format ? `?format=${format}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name) }, body: buf });

test('config endpoint and graceful "not configured" behaviour', async () => {
  const app = await startApp();
  try {
    const cfg = await (await fetch(app.base + '/api/config')).json();
    assert.equal(cfg.instagram.enabled, false);
    assert.equal(cfg.upload.maxMb, 4);
    assert.deepEqual(cfg.conversions.image, ['jpg', 'png', 'webp']);
    assert.equal(JSON.stringify(cfg).includes('xxxx'), false, 'session secret never exposed');
    const r = await post(app, '/api/resolve', { url: 'https://www.instagram.com/p/ABCdef12345/' });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'INSTAGRAM_NOT_CONFIGURED');
    const start = await fetch(app.base + '/auth/instagram', { redirect: 'manual' });
    assert.equal(start.headers.get('location'), '/?auth_error=not_configured');
  } finally {
    await app.close();
  }
});

test('security headers, origin check and request validation', async () => {
  const app = await startApp();
  try {
    const res = await fetch(app.base + '/api/config');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const evil = await post(app, '/api/resolve', { url: 'https://www.instagram.com/p/ABCdef12345/' }, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal((await post(app, '/api/resolve', { url: 'nope' }, { Origin: app.base })).status, 400);
    for (const [url, code] of [['', 'EMPTY'], ['https://example.com/p/ABCdef12345/', 'NOT_INSTAGRAM'], ['https://www.instagram.com/someuser/', 'UNSUPPORTED_URL']]) {
      const r = await post(app, '/api/resolve', { url });
      assert.equal(r.status, 400, url);
      assert.equal((await r.json()).error.code, code, url);
    }
    assert.equal((await fetch(app.base + '/api/resolve', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    const badJson = await fetch(app.base + '/api/resolve', { method: 'POST', headers: JSON_HEADERS, body: '{oops' });
    assert.equal((await badJson.json()).error.code, 'INVALID_JSON');
    assert.equal((await post(app, '/api/resolve', { url: 'x'.repeat(40000) })).status, 413);
  } finally {
    await app.close();
  }
});

test('rate limiting kicks in on heavy endpoints', async () => {
  const app = await startApp({ env: { RATE_LIMIT_HEAVY: '3' } });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(app, '/api/resolve', { url: 'bad' })).status);
    assert.deepEqual(statuses, [400, 400, 400, 429, 429]);
  } finally {
    await app.close();
  }
});

/* =============================== image converter =============================== */

test('image conversion returns real, correctly typed files with attachment headers', async () => {
  const app = await startApp();
  try {
    const png = await makePng();
    for (const [format, ext, mime] of [['jpg', 'jpg', 'image/jpeg'], ['webp', 'webp', 'image/webp'], ['png', 'png', 'image/png']]) {
      const r = await convert(app, png, format, 'My Photo ✨.png');
      assert.equal(r.status, 200, format);
      assert.equal(r.headers.get('content-type'), mime);
      assert.match(r.headers.get('content-disposition'), new RegExp(`^attachment; filename="My_Photo__\\.${ext}"; filename\\*=UTF-8''My%20Photo%20%E2%9C%A8\\.${ext}$`));
      assert.match(r.headers.get('content-security-policy'), /sandbox/);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(sniff(bytes).ext, ext);
      assert.equal(Number(r.headers.get('content-length')), bytes.length);
    }
    // transparent PNG -> JPG is flattened onto white
    const sharp = require('sharp');
    const jpg = Buffer.from(await (await convert(app, png, 'jpg')).arrayBuffer());
    const { data } = await sharp(jpg).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[0] > 150 && data[1] > 100);
    // JPEG in, WebP out
    const w = await convert(app, await makeJpeg(), 'webp');
    assert.equal(sniff(Buffer.from(await w.arrayBuffer())).ext, 'webp');
  } finally {
    await app.close();
  }
});

test('converter rejects bad input safely', async () => {
  const app = await startApp();
  try {
    const png = await makePng();
    const cases = [
      ['text file', Buffer.from('hello world, definitely not media'), 'jpg', 415, 'UNSUPPORTED_FILE'],
      ['svg with script', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'png', 415, 'UNSUPPORTED_FILE'],
      ['html named .png', Buffer.from('<html><body>hi there</body></html>'), 'png', 415, 'UNSUPPORTED_FILE'],
      ['empty', Buffer.alloc(0), 'jpg', 415, 'UNSUPPORTED_FILE'],
      ['video', makeMp4(), 'jpg', 415, 'VIDEO_NOT_SUPPORTED'],
      ['corrupt png', Buffer.concat([png.subarray(0, 40), Buffer.alloc(100, 7)]), 'jpg', 422, 'CONVERSION_FAILED'],
      ['bad format', png, 'exe', 400, 'UNSUPPORTED_FORMAT'],
      ['no format', png, '', 400, 'UNSUPPORTED_FORMAT'],
      ['format injection', png, '../../etc/passwd', 400, 'UNSUPPORTED_FORMAT'],
    ];
    for (const [label, buf, fmt, status, code] of cases) {
      const r = await convert(app, buf, fmt);
      assert.equal(r.status, status, label);
      assert.equal((await r.json()).error.code, code, label);
    }
  } finally {
    await app.close();
  }
});

test('converter enforces the size limit for declared and chunked bodies', async () => {
  const app = await startApp({ env: { MAX_UPLOAD_MB: '1' } });
  try {
    const big = await convert(app, Buffer.alloc(1024 * 1024 + 10, 1), 'jpg');
    assert.equal(big.status, 413);
    assert.equal((await big.json()).error.code, 'FILE_TOO_LARGE');
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${app.base}/api/convert?format=jpg`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      for (let i = 0; i < 6; i++) req.write(Buffer.alloc(256 * 1024, 2));
      req.end();
    });
    assert.equal(status, 413);
  } finally {
    await app.close();
  }
});

/* ============================ Instagram (official API) ============================ */

async function igApp(fake, env = {}) {
  return startApp({
    env: { INSTAGRAM_APP_ID: 'app-id', INSTAGRAM_APP_SECRET: 'secret', ...env },
    configure: (c) => {
      c.instagram.tokenUrl = `${fake.base}/oauth/access_token`;
      c.instagram.graphBase = fake.base;
      c.isAllowedMediaUrl = (u) => u.startsWith(`${fake.base}/cdn/`);
    },
  });
}

async function connect(app) {
  const start = await fetch(app.base + '/auth/instagram', { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  const cb = await fetch(`${app.base}/auth/instagram/callback?code=good-code&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { Cookie: cookieOf(start, 'oauth_state') } });
  return { start, loc, cb, sid: cookieOf(cb, 'sid') };
}

test('OAuth flow: authorize URL, CSRF state, token exchange, encrypted session cookie, logout', async () => {
  const fake = await startFakeInstagram();
  const app = await igApp(fake);
  try {
    const { start, loc, cb, sid } = await connect(app);
    assert.equal(loc.origin + loc.pathname, 'https://www.instagram.com/oauth/authorize');
    assert.equal(loc.searchParams.get('client_id'), 'app-id');
    assert.equal(loc.searchParams.get('scope'), 'instagram_business_basic');
    assert.equal(loc.toString().includes('secret'), false);
    assert.match(start.headers.getSetCookie()[0], /HttpOnly/);
    assert.equal(cb.headers.get('location'), '/?connected=1');
    assert.ok(sid);
    assert.match(cb.headers.getSetCookie().find((c) => c.startsWith('sid=')), /HttpOnly; SameSite=Lax/);

    // the cookie holds the token only in encrypted form
    const value = decodeURIComponent(sid.split('=')[1]);
    assert.equal(value.includes('tok123'), false);
    assert.equal(Buffer.from(value, 'base64url').toString('latin1').includes('tok123'), false);
    assert.ok(sid.length < 1200, 'cookie comfortably under browser limits');

    const session = await (await fetch(app.base + '/api/session', { headers: { Cookie: sid } })).json();
    assert.deepEqual({ connected: session.connected, username: session.username }, { connected: true, username: 'tester' });
    assert.equal(JSON.stringify(session).includes('tok123'), false);
    assert.equal((await (await fetch(app.base + '/api/session')).json()).connected, false);

    // forged / tampered / foreign-secret cookies are ignored
    const tampered = sid.slice(0, -3) + (sid.endsWith('AAA') ? 'BBB' : 'AAA');
    assert.equal((await (await fetch(app.base + '/api/session', { headers: { Cookie: tampered } })).json()).connected, false);
    assert.equal((await (await fetch(app.base + '/api/session', { headers: { Cookie: 'sid=forged' } })).json()).connected, false);
    const other = await igApp(fake, { SESSION_SECRET: 'q'.repeat(40) });
    assert.equal((await (await fetch(other.base + '/api/session', { headers: { Cookie: sid } })).json()).connected, false);
    await other.close();

    const out = await post(app, '/api/logout', {}, { Cookie: sid });
    assert.match(out.headers.getSetCookie().find((c) => c.startsWith('sid=')), /Max-Age=0/);
  } finally {
    await app.close();
    await fake.close();
  }
});

test('OAuth callback rejects forged state, missing cookie, denial and bad codes', async () => {
  const fake = await startFakeInstagram();
  const app = await igApp(fake);
  try {
    const start = await fetch(app.base + '/auth/instagram', { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const stateCookie = cookieOf(start, 'oauth_state');
    const hit = async (qs, cookie) => (await fetch(`${app.base}/auth/instagram/callback?${qs}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })).headers.get('location');
    assert.equal(await hit('code=good-code&state=forged', stateCookie), '/?auth_error=state');
    assert.equal(await hit(`code=good-code&state=${state}`, null), '/?auth_error=state');
    assert.equal(await hit('code=good-code', stateCookie), '/?auth_error=state');
    assert.equal(await hit(`error=access_denied&state=${state}`, stateCookie), '/?auth_error=denied');
    assert.equal(await hit(`code=wrong&state=${state}`, stateCookie), '/?auth_error=failed');
    assert.equal(fake.calls.tokenExchanges, 1);
  } finally {
    await app.close();
    await fake.close();
  }
});

test('production without SESSION_SECRET disables Instagram instead of running insecurely', async () => {
  const fake = await startFakeInstagram();
  const app = await startApp({ env: { NODE_ENV: 'production', SESSION_SECRET: '', INSTAGRAM_APP_ID: 'a', INSTAGRAM_APP_SECRET: 's' } });
  try {
    assert.equal((await (await fetch(app.base + '/api/config')).json()).instagram.enabled, false);
  } finally {
    await app.close();
    await fake.close();
  }
});

test('resolve: own media found (post, reel, carousel); not-owned and unavailable media handled', async () => {
  const fake = await startFakeInstagram();
  const app = await igApp(fake);
  try {
    const anon = await post(app, '/api/resolve', { url: 'https://www.instagram.com/reel/REELCODE123/' });
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error.code, 'AUTH_REQUIRED');

    const { sid } = await connect(app);
    const resolve = (url) => post(app, '/api/resolve', { url }, { Cookie: sid });
    for (const url of ['https://www.instagram.com/reel/REELCODE123/?igsh=abc', 'https://www.instagram.com/tester/reel/REELCODE123/', 'instagram.com/reels/REELCODE123']) {
      const r = await resolve(url);
      assert.equal(r.status, 200, url);
      const data = await r.json();
      assert.equal(data.type, 'reel');
      assert.equal(data.items[0].mediaType, 'VIDEO');
      assert.deepEqual(data.items[0].formats, ['MP4']);
      assert.equal(JSON.stringify(data).includes(fake.base), false, 'CDN URLs must not leak');
      assert.equal(JSON.stringify(data).includes('tok123'), false);
    }
    const car = await (await resolve('https://www.instagram.com/p/CAROUSEL001/')).json();
    assert.equal(car.carousel, true);
    assert.deepEqual(car.items.map((i) => i.mediaType), ['IMAGE', 'VIDEO']);
    const missing = await resolve('https://www.instagram.com/p/NOTMINE0001/');
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error.message, /@tester/);
    const copy = await resolve('https://www.instagram.com/reel/COPYRIGHT001/');
    assert.equal(copy.status, 422);
    assert.equal((await resolve('https://example.com/p/ABCdef12345/')).status, 400);
  } finally {
    await app.close();
    await fake.close();
  }
});

test('Instagram media proxy: real bytes, attachment headers, ranges, tamper-proof handles and SSRF guard', async () => {
  const fake = await startFakeInstagram();
  const app = await igApp(fake);
  try {
    const { sid } = await connect(app);
    const resolve = async (url) => (await post(app, '/api/resolve', { url }, { Cookie: sid })).json();
    const car = await resolve('https://www.instagram.com/p/CAROUSEL001/');
    const [imgItem, vidItem] = car.items;

    const dlImg = await fetch(app.base + imgItem.downloadUrl, { headers: { Cookie: sid } });
    assert.equal(dlImg.headers.get('content-type'), 'image/jpeg');
    assert.equal(dlImg.headers.get('content-disposition'), `attachment; filename="instagram-CAROUSEL001-1.jpg"; filename*=UTF-8''instagram-CAROUSEL001-1.jpg`);
    assert.ok(Buffer.from(await dlImg.arrayBuffer()).equals(fake.jpeg));

    const dlVid = await fetch(app.base + vidItem.downloadUrl, { headers: { Cookie: sid } });
    assert.equal(dlVid.headers.get('content-type'), 'video/mp4');
    assert.ok(Buffer.from(await dlVid.arrayBuffer()).equals(fake.mp4));

    const range = await fetch(app.base + vidItem.previewUrl, { headers: { Cookie: sid, Range: 'bytes=0-49' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 50);
    const poster = await fetch(app.base + vidItem.posterUrl, { headers: { Cookie: sid } });
    assert.equal(poster.headers.get('content-type'), 'image/jpeg');
    await poster.arrayBuffer();

    // needs the session cookie; handles cannot be forged, edited or reused as a session
    assert.equal((await fetch(app.base + imgItem.downloadUrl)).status, 401);
    const token = imgItem.downloadUrl.split('/')[4].split('?')[0];
    const forged = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA');
    assert.equal((await fetch(`${app.base}/api/ig/item/${forged}/media`, { headers: { Cookie: sid } })).status, 404);
    assert.equal((await fetch(`${app.base}/api/ig/item/${sid.split('=')[1]}/media`, { headers: { Cookie: sid } })).status, 404, 'session cookie is not an item handle');
    assert.equal((await fetch(`${app.base}/api/ig/item/nonsense/media`, { headers: { Cookie: sid } })).status, 404);

    // SSRF: API returned a URL outside the CDN allowlist
    const evil = await resolve('https://www.instagram.com/p/EVILURL0001/');
    const blocked = await fetch(app.base + evil.items[0].downloadUrl, { headers: { Cookie: sid } });
    assert.equal(blocked.status, 502);
    assert.equal((await blocked.json()).error.code, 'BLOCKED_HOST');
  } finally {
    await app.close();
    await fake.close();
  }
});

test('expired session cookie is rejected', async () => {
  const fake = await startFakeInstagram();
  const app = await igApp(fake);
  try {
    const expired = app.sessions.sealer.seal('session', { t: 'tok123', u: '42', n: 'tester' }, Date.now() - 1000);
    const r = await post(app, '/api/resolve', { url: 'https://www.instagram.com/reel/REELCODE123/' }, { Cookie: `sid=${expired}` });
    assert.equal(r.status, 401);
    const valid = app.sessions.sealer.seal('session', { t: 'tok123', u: '42', n: 'tester' }, Date.now() + 60000);
    assert.equal((await post(app, '/api/resolve', { url: 'https://www.instagram.com/reel/REELCODE123/' }, { Cookie: `sid=${valid}` })).status, 200);
  } finally {
    await app.close();
    await fake.close();
  }
});
