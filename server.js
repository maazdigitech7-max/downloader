'use strict';

const path = require('node:path');
const { loadConfig, loadDotEnv } = require('./src/config');

loadDotEnv();

const express = require('express');
const { FileStore } = require('./src/store');
const { SessionStore } = require('./src/sessions');
const { MediaService } = require('./src/media');
const { InstagramClient } = require('./src/instagram');
const { createRoutes } = require('./src/routes');
const { handleError, sendJson } = require('./src/http');

async function main() {
  const config = loadConfig();
  const store = new FileStore({ ...config.upload });
  await store.init();
  const media = new MediaService(config);
  const available = await media.init();
  const sessions = new SessionStore();
  const instagram = new InstagramClient(config.instagram);
  const { routes, middleware } = createRoutes({ config, sessions, store, instagram, media });

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) {
    app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy === 'true' ? true : config.trustProxy);
  }

  app.use(...middleware);
  for (const r of routes) app[r.method](r.path, ...r.middleware, r.handler);

  app.use(['/api', '/auth'], (req, res) => {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown API route.' } });
  });
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir, { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));
  app.use((req, res) => res.status(404).sendFile(path.join(publicDir, '404.html')));
  app.use((err, req, res, _next) => handleError(err, req, res));

  const server = app.listen(config.port, () => {
    console.log(`InstaSave running at ${config.baseUrl} (port ${config.port})`);
    console.log(`  Instagram connection : ${config.instagram.enabled ? 'enabled' : 'disabled (set INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET)'}`);
    console.log(`  ffmpeg formats       : ${Object.entries(available).filter(([, ok]) => ok).map(([f]) => f).join(', ')}`);
  });

  const shutdown = async () => {
    server.close();
    sessions.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start InstaSave:', err);
  process.exit(1);
});
