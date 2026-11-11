'use strict';

// Local development server: `npm start`. On Vercel this file is not used (see api/index.js).
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
