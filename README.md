# InstaSave

A responsive web app for downloading Instagram media **you own or are authorized to access**, plus an upload tool to download and convert your own image/video files.

- **Frontend:** plain HTML5, CSS3 and JavaScript (no framework; React would add nothing here).
- **Backend:** Node.js + Express. Only two runtime dependencies: `express` and `sharp`.

## What it does (and does not do)

| Feature | How it works |
|---|---|
| **Link mode** (Reels, videos, photos, carousels) | You connect your Instagram account through Instagram's **official OAuth** (*Instagram API with Instagram Login*). The server reads **your own** media via the official Graph API, finds the post matching the pasted link, previews it and streams the original file to you. |
| **Upload mode** | Upload a JPG/PNG/WebP/GIF/MP4/MOV/WebM file, download it, or convert it (images → JPG/PNG/WebP; videos → MP4/WebM/MP3 via ffmpeg). Works with no Instagram account. |

**Limitations (by design, and shown in the UI):**

- Instagram's official API only exposes media of the account that authorized your app. **Arbitrary public URLs cannot be downloaded**, and InstaSave does not pretend otherwise: a link that is not in the connected account returns a clear "not found in your account" message.
- The official API requires an Instagram **professional** account (Business or Creator).
- Only the most recent posts are searched (`INSTAGRAM_MAX_PAGES` × 50).
- Instagram omits the file for media with copyrighted audio. Stories and private content are unsupported.
- Without a Meta app that has **Advanced Access** (App Review), only accounts you own / added as testers in your Meta app can connect.
- There is no scraping, no private API, no cookie/login extraction, no authentication bypass.

## Requirements

- Node.js **20.12 or newer**
- (Optional) `ffmpeg` on the PATH for video/audio conversion. Image tools work without it; the UI only offers formats that the server can really produce.

## Quick start (upload tool works immediately)

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

Open http://localhost:3000.

## Enable "connect Instagram" (link mode)

1. Go to https://developers.facebook.com/apps and create an app of type **Business**.
2. Add the **Instagram** product and choose **API setup with Instagram login**.
3. In **Business login settings**, add this OAuth redirect URI exactly: `http://localhost:3000/auth/instagram/callback` (use your real HTTPS URL in production).
4. Copy the **Instagram app ID** and **Instagram app secret** (shown on that same page; they differ from the Facebook ones) into `.env`:
   ```
   INSTAGRAM_APP_ID=...
   INSTAGRAM_APP_SECRET=...
   ```
5. Add your own Instagram professional account as an Instagram tester/test account for the app (App roles), accept the invite in the Instagram app, then restart the server and click **Connect Instagram**.
6. To let other people connect, your app must pass Meta's App Review for the `instagram_business_basic` permission and go live.

Meta's docs change over time; check https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login for the current steps and API version (`INSTAGRAM_API_VERSION`).

## Configuration

All configuration is via environment variables (see `.env.example`). No secrets are in the source code. Highlights: `PORT`, `BASE_URL`, `TRUST_PROXY`, `INSTAGRAM_*`, `MAX_UPLOAD_MB`, `MAX_STORAGE_MB`, `FILE_TTL_MINUTES`, `FFMPEG_PATH`, `RATE_LIMIT_*`.

## Project structure

```
server.js              Express app: middleware, routes, static files, shutdown
src/config.js          Environment configuration + CDN allow-list (SSRF guard)
src/routes.js          All API route handlers (route table)
src/instagram.js       Official Instagram API client (OAuth, media lookup)
src/sessions.js        Server-side sessions (token never reaches the browser)
src/store.js           Temporary file store with TTL + capacity cap
src/media.js           File-type sniffing, image (sharp) and video (ffmpeg) conversion
src/http.js            JSON/cookie helpers, security headers, CSRF origin check, rate limiter
public/index.html      Single-page site (header, hero, features, how it works, FAQ, about, footer)
public/style.css       Design system (white, purple→blue gradient, responsive)
public/script.js       UI logic (validation, paste, previews, upload, convert, downloads)
public/js/validators.js  URL validation shared by browser and server
public/privacy.html, terms.html, 404.html
tests/                 Automated tests (node:test) + optional browser end-to-end check
```

## API

| Method & path | Purpose |
|---|---|
| `GET /api/config` | Public settings and available conversion formats |
| `GET /api/session`, `POST /api/logout` | Connection status / disconnect |
| `GET /auth/instagram`, `GET /auth/instagram/callback` | Official OAuth (with CSRF `state`) |
| `POST /api/resolve` `{url}` | Validate the link, find it in the connected account, return previews |
| `GET /api/ig/item/:id/:variant` | Stream an item (`media` or `thumb`; `?download=1` to attach) |
| `POST /api/upload` | Raw file body + `X-Filename` header |
| `POST /api/convert` `{id, format}` | Convert an uploaded file |
| `GET /api/files/:id/preview` · `/download`, `DELETE /api/files/:id` | Serve or delete a stored file |

Errors are always `{ "error": { "code", "message" } }`.

## Security notes

- Access tokens stay server-side; the browser only gets an opaque HttpOnly session cookie. OAuth uses a random `state` checked in constant time.
- Media is fetched only from `https` Instagram/Facebook CDN hosts, with no redirects followed.
- Uploads are identified by file **content** (magic bytes), never by name or browser type; stored as `0600` files with random 128-bit names; deleted after `FILE_TTL_MINUTES`; capped per file and in total. Images are decoded to confirm validity and bounded in pixel count. SVG/HTML are rejected. Files are served with `nosniff` and a sandbox CSP.
- Strict CSP (no inline script/style), `X-Frame-Options: DENY`, same-origin check on all state-changing requests, per-IP rate limits, ffmpeg run without a shell, with a timeout and concurrency limit.
- Sessions and rate-limit counters are in memory: run a **single instance**, or move them to Redis before scaling horizontally.

## Tests

```bash
npm test                          # 21 tests: validation, API routes, OAuth, uploads, conversions, downloads, security
npm i -D playwright && npx playwright install chromium
node tests/e2e/browser-check.js   # drives the real UI on desktop + mobile viewports
```

The tests use a fake Instagram API server, so no credentials are needed.

## Deployment

1. Pick a host that runs Node 20.12+ (VPS, Render, Railway, Fly.io…). For video conversion make sure `ffmpeg` is installed (e.g. `apt install ffmpeg`).
2. Set environment variables: `NODE_ENV=production`, `BASE_URL=https://your.domain`, `TRUST_PROXY=1` (behind one proxy), `INSTAGRAM_*`, `CONTACT_EMAIL`.
3. Register `https://your.domain/auth/instagram/callback` in Meta's Business login settings.
4. `npm ci --omit=dev && npm start`. Keep it alive with systemd or `pm2 start server.js --name instasave`.
5. Put it behind HTTPS (Caddy/nginx/your platform). Example nginx location: `proxy_pass http://127.0.0.1:3000;` with `client_max_body_size 110m;`, and `proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr;`.
6. Review `privacy.html` and `terms.html`: they are templates, not legal advice.

## Extending

- New output format: add it to `OUTPUT_MIME`, `REQUIRED_ENCODERS` and the ffmpeg/sharp switch in `src/media.js`.
- Public-post previews: Meta's oEmbed Read feature returns a preview/thumbnail for public posts, but never a download file. It could be added in `src/instagram.js`.
- Multi-instance: replace `SessionStore` and the rate limiter with Redis-backed versions.

## Disclaimer

Not affiliated with Instagram or Meta. Only download media you own or have permission to use.
