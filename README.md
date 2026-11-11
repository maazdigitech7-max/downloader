# InstaSave (Vercel edition)

Download Instagram media you **own or are authorized to access**, plus an image converter. Plain HTML/CSS/JS front end, Express API running as a Vercel Function.

## What works on Vercel (and what doesn't)

| Feature | Status |
|---|---|
| Website, FAQ, privacy/terms pages | Works immediately, no setup |
| **Image converter** (JPG/PNG/WebP/GIF → JPG/PNG/WebP, up to 4 MB) | Works immediately, no setup. Done in memory, nothing is stored |
| **Link downloads** (your own Reels, videos, photos, carousels) | Works after you add the Meta app keys below |
| Video/audio conversion | **Not available**: Vercel has no ffmpeg (use the classic Render/Docker edition for that) |
| Uploads over ~4.5 MB | **Not possible**: Vercel rejects larger request bodies |

Why it is different from a normal server: serverless functions have no persistent disk and no memory between requests, so this edition keeps **no files and no server-side sessions**. The Instagram login is an AES-256-GCM encrypted HttpOnly cookie, and downloadable items are encrypted, tamper-proof handles.

Instagram limits (unchanged): the official API only exposes media of the account that signs in, requires a professional (Business/Creator) account, and only your own account/testers can connect until your Meta app passes App Review. Arbitrary public URLs cannot be downloaded.

## Deploy: GitHub → Vercel

1. **Push to GitHub** (from this folder):
   ```bash
   git init
   git add .
   git commit -m "InstaSave"
   git branch -M main
   git remote add origin https://github.com/YOUR_USER/instasave.git
   git push -u origin main
   ```
2. On https://vercel.com/new **import the repository**. Leave Framework Preset as **Other**; no build command, no output directory. Click **Deploy**.
3. Open the deployed URL. The site and the image converter already work. "Connect Instagram" will say it isn't set up yet.

### Enable "Connect Instagram"

1. https://developers.facebook.com/apps → create an app of type **Business** → add the **Instagram** product → **API setup with Instagram login**.
2. In **Business login settings** add this redirect URI exactly (use your real domain):
   `https://YOUR-PROJECT.vercel.app/auth/instagram/callback`
3. In Vercel → Project → **Settings → Environment Variables** add:

   | Name | Value |
   |---|---|
   | `INSTAGRAM_APP_ID` | Instagram app ID from that Meta page (not the Facebook one) |
   | `INSTAGRAM_APP_SECRET` | Instagram app secret |
   | `SESSION_SECRET` | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `BASE_URL` | *(only with a custom domain)* `https://your.domain` |
   | `CONTACT_EMAIL` | *(optional)* shows a Contact link in the footer |

4. **Redeploy** (Deployments → ⋯ → Redeploy) so the variables take effect.
5. Add your Instagram professional account as a tester of the Meta app (App roles) and accept the invite in the Instagram app. Then click **Connect Instagram** on your site.

If a variable is missing, the site does not crash: the Instagram feature stays off and a warning is written to the Function logs (Vercel → Logs).

## Local development

```bash
npm install
cp .env.example .env
npm start            # http://localhost:3000
npm test             # 19 tests, no credentials or ffmpeg needed
```
Requires Node 22 (`.nvmrc`-style `engines: 22.x`).

## Structure

```
api/index.js        Vercel Function entry: exports the Express app
vercel.json         Rewrites /api/* and /auth/* to the function, security headers, maxDuration
dev-server.js       Local dev server only (also serves public/). Not used on Vercel
src/app.js          Express app factory (API + OAuth)
src/routes.js       Route handlers
src/instagram.js    Official Instagram API client
src/seal.js         AES-256-GCM sealing for cookies/handles
src/sessions.js     Stateless, encrypted-cookie sessions
src/media.js        Content sniffing + sharp image conversion (in memory, sharp loads lazily)
src/validators.js   URL validator (server copy; identical copy in public/js/validators.js for the browser)
src/http.js         Helpers, CSRF origin check, rate limiter
public/             index.html, style.css, script.js, privacy/terms/404 (served by Vercel's CDN)
tests/              Automated tests + optional Playwright browser check
```

## Security notes

- Instagram token is only ever inside an encrypted cookie; random OAuth `state` is verified; media is fetched only from Instagram/Facebook CDN hosts (https, no redirects); item handles are bound to the signed-in user and expire with the session.
- Uploads are identified by content (not name), SVG/HTML rejected, pixel-bomb limit, no data written to disk.
- Strict CSP and security headers on both static files (via `vercel.json`) and API responses.
- Sessions can't be revoked server-side (stateless); they expire with the Instagram token (~1 hour).
- The per-IP rate limiter is in memory, so on serverless it is best-effort per warm instance. For real protection enable Vercel's Firewall / rate limiting.

## Troubleshooting

- **First check:** open `https://YOUR-SITE/api/health`. It shows the Node version, whether the image converter loaded, and whether the Instagram connection is configured (never any secrets). If `/` (the homepage) shows an error, the project layout is wrong, see the next point.
- **Repo layout:** in GitHub, the **root** of the repository must directly contain `api/`, `public/`, `src/`, `package.json` and `vercel.json`. If you see a single folder like `instasave-vercel/` at the root, move its contents up one level (or set Vercel → Settings → General → **Root Directory** to that folder).
- **Framework Preset** must be **Other** (vercel.json already forces it) and Build Command / Output Directory should be left empty/untouched.

- **500 FUNCTION_INVOCATION_FAILED**: open Vercel → your deployment → **Logs** and read the first error. Make sure Node.js version is 22.x (Settings → General) and that the deploy used `npm install` (sharp must install).
- **"Connect Instagram" says not set up**: one of `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `SESSION_SECRET` is missing/too short; redeploy after adding.
- **Instagram redirect error**: the redirect URI in Meta must match `BASE_URL`/your domain exactly.
- **Large Instagram videos fail**: Vercel limits non-streamed responses to 4.5 MB. The proxy streams, which normally avoids it, but if you hit it use the classic server edition.

Not affiliated with Instagram or Meta. Only download media you own or have permission to use.
