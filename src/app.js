'use strict';

const { loadConfig, loadDotEnv } = require('./config');
const { SessionManager } = require('./sessions');
const { MediaService } = require('./media');
const { InstagramClient } = require('./instagram');
const { createRoutes } = require('./routes');
const { handleError, sendJson } = require('./http');

/**
 * Builds the Express app (API + OAuth only). It is used both by Vercel (api/index.js, which
 * exports it as a function) and by server.js for local development (which also serves public/).
 */
function createApp(express) {
  loadDotEnv();
  const config = loadConfig();
  if (config.instagram.problem) {
    console.warn(`[config] Instagram connection disabled: ${config.instagram.problem}. See README (INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, SESSION_SECRET).`);
  }
  const sessions = new SessionManager({ secret: config.sessionSecret, secure: config.isProd });
  const instagram = new InstagramClient(config.instagram);
  const media = new MediaService();
  const { routes, middleware } = createRoutes({ config, sessions, instagram, media });

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) {
    app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy === 'true' ? true : config.trustProxy);
  }
  app.use(...middleware);
  for (const r of routes) app[r.method](r.path, ...r.middleware, r.handler);
  app.use(['/api', '/auth'], (req, res) => sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown API route.' } }));
  app.use((err, req, res, _next) => handleError(err, req, res));
  return { app, config };
}

module.exports = { createApp };
