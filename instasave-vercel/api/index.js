'use strict';

// Vercel entry point: every /api/* and /auth/* request is rewritten here (see vercel.json).
// Static files in public/ are served directly by Vercel's CDN and never reach this function.
const express = require('express');
const { createApp } = require('../src/app');

module.exports = createApp(express).app;
