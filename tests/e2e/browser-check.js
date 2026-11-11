'use strict';

/**
 * Optional end-to-end check in a real browser (needs `playwright` + a Chromium build).
 *   node tests/e2e/browser-check.js
 * It starts the real app routes plus a fake Instagram API and drives the actual UI
 * on desktop and mobile viewports, failing on any console error or CSP violation.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { startApp } = require('../helpers/harness');
const { startFakeInstagram } = require('../helpers/fakeInstagram');
const { makePng, makeMp4 } = require('../helpers/fixtures');

const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', '..', 'tmp-shots');

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const fake = await startFakeInstagram();
  const app = await startApp({
    staticDir: path.join(__dirname, '..', '..', 'public'),
    env: { INSTAGRAM_APP_ID: 'app-id', INSTAGRAM_APP_SECRET: 'secret', CONTACT_EMAIL: 'hello@example.com', RATE_LIMIT_HEAVY: '500' },
    configure: (c) => {
      c.instagram.tokenUrl = `${fake.base}/oauth/access_token`;
      c.instagram.graphBase = fake.base;
      c.instagram.authUrl = `${fake.base}/oauth/authorize`;
      c.isAllowedMediaUrl = (u) => u.startsWith(`${fake.base}/cdn/`);
    },
  });
  app.config.instagram.redirectUri = `${app.base}/auth/instagram/callback`;

  const browser = await chromium.launch();
  const problems = [];
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'is-e2e-'));
  fs.writeFileSync(path.join(tmp, 'photo.png'), await makePng());
  fs.writeFileSync(path.join(tmp, 'clip.mp4'), makeMp4());
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'plain text, not media');

  async function run(name, contextOptions) {
    const context = await browser.newContext({ acceptDownloads: true, ...contextOptions });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.base }).catch(() => {});
    const page = await context.newPage();
    page.on('console', (m) => {
      if (!['error', 'warning'].includes(m.type())) return;
      // Chromium logs every 4xx response; this script provokes 401/404/415 on purpose (negative tests).
      if (/Failed to load resource: the server responded with a status of (401|404|415)/.test(m.text())) return;
      problems.push(`[${name}] console.${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`[${name}] requestfailed: ${r.url()} ${r.failure()?.errorText}`));

    await page.goto(app.base + '/');
    await page.waitForSelector('#connectBar:not([hidden])');
    await page.screenshot({ path: path.join(SHOTS, `${name}-1-home.png`) });

    // Header + sections exist
    for (const t of ['Home', 'How It Works', 'FAQ', 'About Us']) assert.ok(await page.getByRole('link', { name: t, exact: true }).count() > 0 || await page.locator('#navToggle').isVisible(), t);
    assert.equal(await page.locator('h1').innerText(), 'Instagram Downloader');
    assert.equal(await page.locator('.subtitle').innerText(), 'Download Instagram Reels, videos, and photos easily.');
    assert.ok(await page.locator('#contactLink').isVisible(), 'contact link shown when CONTACT_EMAIL set');
    // no horizontal scroll
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);

    // --- URL validation (client side) ---
    await page.fill('#urlInput', 'https://example.com/p/ABCdef12345/');
    await page.click('#submitBtn');
    assert.match(await page.locator('#message').innerText(), /Only instagram\.com links/);
    assert.equal(await page.locator('#urlInput').getAttribute('aria-invalid'), 'true');
    await page.fill('#urlInput', '');
    await page.click('#submitBtn');
    assert.match(await page.locator('#message').innerText(), /paste an Instagram link/i);

    // --- Paste button ---
    await page.evaluate(() => navigator.clipboard.writeText('https://www.instagram.com/reel/REELCODE123/'));
    await page.click('#pasteBtn');
    await page.waitForFunction(() => document.querySelector('#urlInput').value !== '');
    assert.equal(await page.inputValue('#urlInput'), 'https://www.instagram.com/reel/REELCODE123/');

    // --- Not connected -> clear message + highlighted connect bar ---
    await page.click('#submitBtn');
    await page.waitForSelector('#message.is-error');
    assert.match(await page.locator('#message').innerText(), /Connect your Instagram account/);
    await page.screenshot({ path: path.join(SHOTS, `${name}-2-needs-connect.png`) });

    // --- Connect via (fake) official OAuth, then download a reel ---
    await Promise.all([page.waitForURL(/\/\?connected=1|\/$/), page.click('text=Connect Instagram')]);
    await page.waitForSelector('#connectBar strong:has-text("@tester")');
    assert.match(await page.locator('#message').innerText(), /Connected as @tester/);
    assert.equal(new URL(page.url()).search, '', 'query string cleaned up');

    await page.fill('#urlInput', 'https://www.instagram.com/reel/REELCODE123/');
    await page.click('#submitBtn');
    await page.waitForSelector('.result-card video');
    assert.equal(await page.locator('.media-tile').count(), 1);
    assert.ok(await page.locator('.chip', { hasText: 'MP4' }).count() > 0);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Download video')]);
    assert.equal(dl.suggestedFilename(), 'instagram-REELCODE123.mp4');
    const saved = path.join(tmp, 'saved.mp4');
    await dl.saveAs(saved);
    assert.ok(fs.readFileSync(saved).equals(fake.mp4), 'browser-downloaded file identical to source');
    await page.screenshot({ path: path.join(SHOTS, `${name}-3-reel.png`) });

    // --- Carousel ---
    await page.fill('#urlInput', 'https://www.instagram.com/p/CAROUSEL001/');
    await page.click('#submitBtn');
    await page.waitForFunction(() => document.querySelectorAll('.media-tile').length === 2);
    assert.equal(await page.locator('.media-tile img').count(), 1);
    assert.equal(await page.locator('.media-tile video').count(), 1);
    // images actually loaded through the proxy
    await page.waitForFunction(() => [...document.querySelectorAll('.media-tile img')].every((i) => i.complete && i.naturalWidth > 0));
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('.media-tile').first().locator('a.btn').click()]);
    assert.equal(dl2.suggestedFilename(), 'instagram-CAROUSEL001-1.jpg');
    await page.screenshot({ path: path.join(SHOTS, `${name}-4-carousel.png`) });

    // --- Post that is not in the connected account ---
    await page.fill('#urlInput', 'https://www.instagram.com/p/NOTMINE0001/');
    await page.click('#submitBtn');
    await page.waitForSelector('#message.is-error');
    assert.match(await page.locator('#message').innerText(), /not found among the most recent posts of @tester/);
    assert.equal(await page.locator('.result-card').count(), 0);

    // --- Image converter tab: keyboard nav, bad files, convert + download ---
    await page.focus('#tab-link');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#panel-upload').isVisible(), true);
    await page.setInputFiles('#fileInput', path.join(tmp, 'notes.txt'));
    await page.waitForSelector('#message.is-error');
    assert.match(await page.locator('#message').innerText(), /JPG, PNG, WebP or GIF/);

    await page.setInputFiles('#fileInput', path.join(tmp, 'photo.png'));
    await page.waitForSelector('.result-card img');
    assert.ok(await page.locator('.result-card img').evaluate((i) => i.complete && i.naturalWidth === 64), 'local preview shown');
    assert.match(await page.locator('.badge').innerText(), /never stored/);
    await page.selectOption('.convert-row select', 'jpg');
    await page.click('.convert-row button');
    await page.waitForFunction(() => document.querySelectorAll('.converted .media-tile').length === 1);
    const [dl3] = await Promise.all([page.waitForEvent('download'), page.locator('.converted a.btn').click()]);
    assert.equal(dl3.suggestedFilename(), 'photo.jpg');
    const jpgPath = path.join(tmp, 'out.jpg');
    await dl3.saveAs(jpgPath);
    assert.deepEqual([...fs.readFileSync(jpgPath).subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.ok(await page.locator('.converted img').evaluate((i) => i.complete && i.naturalWidth === 64), 'converted preview shown');
    await page.screenshot({ path: path.join(SHOTS, `${name}-5-convert.png`) });

    // webp too, then a video is refused with a helpful message
    await page.selectOption('.convert-row select', 'webp');
    await page.click('.convert-row button');
    await page.waitForFunction(() => document.querySelector('.converted .chip')?.textContent === 'WEBP');
    await page.setInputFiles('#fileInput', path.join(tmp, 'clip.mp4'));
    await page.waitForSelector('#message.is-error');
    assert.match(await page.locator('#message').innerText(), /Video files cannot be converted/);
    assert.equal(await page.locator('.result-card').count(), 0);

    // --- Drag & drop of a non-image ---
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['hello'], 'dropped.txt', { type: 'text/plain' }));
      document.querySelector('#dropZone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForSelector('#message.is-error');

    // --- Disconnect ---
    await page.click('[aria-selected="false"][data-tab="link"], #tab-link');
    await page.click('text=Disconnect');
    await page.waitForSelector('text=Connect Instagram');

    // --- Content sections ---
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
    assert.equal(await page.locator('#faq details').count(), 8);
    await page.locator('#faq summary').first().click();
    assert.equal(await page.locator('#faq details').first().getAttribute('open') !== null, true);
    await page.screenshot({ path: path.join(SHOTS, `${name}-6-bottom.png`), fullPage: true });

    // Mobile menu
    if (await page.locator('#navToggle').isVisible()) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.click('#navToggle');
      assert.equal(await page.locator('#nav').isVisible(), true);
      await page.screenshot({ path: path.join(SHOTS, `${name}-7-menu.png`) });
      await page.click('#nav a[href="#faq"]');
      assert.equal(await page.locator('#nav').isVisible(), false);
    }

    // Legal pages
    for (const p of ['/privacy', '/terms']) {
      const r = await page.goto(app.base + p);
      assert.equal(r.status(), 200, p);
      assert.ok(await page.locator('h1').innerText());
    }
    await context.close();
  }

  try {
    await run('desktop', { viewport: { width: 1280, height: 900 } });
    await run('mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  } finally {
    await browser.close();
    await app.close();
    await fake.close();
  }
  if (problems.length) {
    console.error('PROBLEMS:\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log('Browser check passed on desktop and mobile with no console errors or CSP violations.');
})().catch((e) => { console.error(e); process.exit(1); });
