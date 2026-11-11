'use strict';

// Vercel Function entry: every /api/* and /auth/* request is rewritten here (see vercel.json).
// Static files in public/ are served directly by Vercel's CDN and never reach this function.
let handler;
try {
  const express = require('express');
  const { createApp } = require('../src/app');
  handler = createApp(express).app;
} catch (err) {
  // Log the real reason (visible in Vercel -> Logs) and answer with a clear JSON error.
  console.error('[startup] InstaSave failed to start:', err);
  handler = (req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'STARTUP_FAILED', message: 'The server failed to start. Check the Function logs in Vercel.' } }));
  };
}

module.exports = handler;
