'use strict';

/** A tiny stand-in for Instagram's OAuth + Graph API + CDN, used only in tests. */
const http = require('node:http');
const { makeJpeg, makeMp4 } = require('./fixtures');

async function startFakeInstagram() {
  const jpeg = await makeJpeg();
  const mp4 = makeMp4();
  let base = '';
  const calls = { tokenExchanges: 0 };

  const media = () => [
    { id: '1', media_type: 'IMAGE', media_url: `${base}/cdn/image.jpg`, permalink: 'https://www.instagram.com/p/OTHERPOST01/' },
    {
      id: '2', media_type: 'CAROUSEL_ALBUM', media_url: `${base}/cdn/image.jpg`, permalink: 'https://www.instagram.com/p/CAROUSEL001/',
      children: { data: [
        { id: '2a', media_type: 'IMAGE', media_url: `${base}/cdn/image.jpg` },
        { id: '2b', media_type: 'VIDEO', media_url: `${base}/cdn/video.mp4`, thumbnail_url: `${base}/cdn/image.jpg` },
      ] },
    },
  ];
  const page2 = () => [
    { id: '3', media_type: 'VIDEO', media_url: `${base}/cdn/video.mp4`, thumbnail_url: `${base}/cdn/image.jpg`, permalink: 'https://www.instagram.com/reel/REELCODE123/' },
    { id: '4', media_type: 'IMAGE', media_url: 'http://169.254.169.254/latest/meta-data', permalink: 'https://www.instagram.com/p/EVILURL0001/' },
    { id: '5', media_type: 'VIDEO', permalink: 'https://www.instagram.com/reel/COPYRIGHT001/' }, // media_url omitted by Instagram
  ];

  function sendFile(req, res, buf, type) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1] || 0);
      const end = Math.min(buf.length - 1, m[2] ? Number(m[2]) : buf.length - 1);
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Accept-Ranges': 'bytes' });
      return res.end(buf.subarray(start, end + 1));
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Accept-Ranges': 'bytes' });
    res.end(buf);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/oauth/authorize') {
      // Stand-in for Instagram's consent screen: approve immediately.
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'good-code');
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/oauth/access_token') {
      let body = '';
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      calls.tokenExchanges += 1;
      calls.lastExchange = Object.fromEntries(p);
      if (p.get('code') === 'good-code' && p.get('client_secret') === 'secret') return json(200, { data: [{ access_token: 'tok123', user_id: 42, permissions: 'instagram_business_basic' }] });
      return json(400, { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' });
    }
    if (url.pathname.startsWith('/cdn/')) {
      return url.pathname.endsWith('.mp4') ? sendFile(req, res, mp4, 'video/mp4') : sendFile(req, res, jpeg, 'image/jpeg');
    }
    if (url.pathname.startsWith('/v25.0/')) {
      if (url.searchParams.get('access_token') !== 'tok123') return json(401, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } });
      if (url.pathname === '/v25.0/me') return json(200, { user_id: '42', username: 'tester' });
      if (url.pathname === '/v25.0/me/media') {
        if (url.searchParams.get('page') === '2') return json(200, { data: page2() });
        return json(200, { data: media(), paging: { next: `${base}/v25.0/me/media?page=2&access_token=tok123` } });
      }
    }
    json(404, { error: { message: 'unknown', code: 100 } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, jpeg, mp4, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

module.exports = { startFakeInstagram };
