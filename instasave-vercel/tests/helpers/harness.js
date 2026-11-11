'use strict';

/**
 * Test harness. Express is not required to test the app: server.js registers
 * `routes` on Express in a 1-line loop, and this harness registers the very same
 * route table (same middleware, same handlers) on a plain Node HTTP server.
 */
const http = require('node:http');
const path = require('node:path');
const { loadConfig } = require('../../src/config');
const { SessionManager } = require('../../src/sessions');
const { MediaService } = require('../../src/media');
const { InstagramClient } = require('../../src/instagram');
const { createRoutes } = require('../../src/routes');
const { handleError, sendJson } = require('../../src/http');

function compile(routePath) {
  const names = [];
  const re = new RegExp('^' + routePath.replace(/:([a-z]+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$');
  return { re, names };
}


const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
/** Minimal static file server so the real front-end can be exercised in a browser during tests. */
function serveStatic(root, pathname, res, middleware, req) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root)) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } });
  if (!path.extname(file)) file += '.html';
  middleware.forEach((m) => m(req, res, () => {}));
  require('node:fs').readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}

async function startApp({ env = {}, configure, staticDir } = {}) {
  const config = loadConfig({ BASE_URL: 'http://127.0.0.1', SESSION_SECRET: 'x'.repeat(40), ...env });
  if (configure) configure(config);
  const sessions = new SessionManager({ secret: config.sessionSecret, secure: false });
  const instagram = new InstagramClient(config.instagram);
  const media = new MediaService();
  const { routes, middleware } = createRoutes({ config, sessions, instagram, media });
  const table = routes.map((r) => ({ ...r, ...compile(r.path) }));

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const route = table.find((r) => r.method === req.method.toLowerCase() && r.re.test(pathname));
    if (!route && staticDir && req.method === 'GET') return serveStatic(staticDir, pathname, res, middleware, req);
    if (!route) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown API route.' } });
    const m = route.re.exec(pathname);
    req.params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    const chain = [...middleware, ...route.middleware, route.handler];
    let i = 0;
    const next = () => chain[i++](req, res, next);
    try {
      next();
    } catch (err) {
      handleError(err, req, res);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.baseUrl = base;

  return {
    base, config, sessions, media,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { startApp };
