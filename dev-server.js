'use strict';

// LOCAL development server only (`npm start`). Deliberately not named server.js/app.js/index.js so
// Vercel never mistakes it for the app entry point. On Vercel the function is api/index.js.
const path = require('node:path');
const express = require('express');
const { createApp } = require('./src/app');

const { app, config } = createApp(express);
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { extensions: ['html'] }));
app.use((req, res) => res.status(404).sendFile(path.join(publicDir, '404.html')));

app.listen(config.port, () => {
  console.log(`InstaSave running at ${config.baseUrl} (port ${config.port})`);
  console.log(`  Instagram connection: ${config.instagram.enabled ? 'enabled' : 'disabled (' + config.instagram.problem + ')'}`);
});
