'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInstagramUrl } = require('../public/js/validators');

test('accepts supported Instagram URLs', () => {
  const ok = [
    ['https://www.instagram.com/reel/ABCdef12345/', 'reel', 'ABCdef12345'],
    ['https://instagram.com/reel/ABCdef12345', 'reel', 'ABCdef12345'],
    ['https://www.instagram.com/reels/ABCdef12345/?igsh=xyz', 'reel', 'ABCdef12345'],
    ['https://www.instagram.com/p/Cx_-9ab12CD/', 'post', 'Cx_-9ab12CD'],
    ['https://www.instagram.com/someuser/p/Cx_-9ab12CD/', 'post', 'Cx_-9ab12CD'],
    ['https://www.instagram.com/someuser/reel/Cx_-9ab12CD/', 'reel', 'Cx_-9ab12CD'],
    ['https://www.instagram.com/tv/ABCdef12345/', 'video', 'ABCdef12345'],
    ['https://m.instagram.com/p/ABCdef12345/', 'post', 'ABCdef12345'],
    ['https://instagr.am/p/ABCdef12345/', 'post', 'ABCdef12345'],
    ['instagram.com/p/ABCdef12345', 'post', 'ABCdef12345'],
    ['  https://www.instagram.com/p/ABCdef12345/  ', 'post', 'ABCdef12345'],
    ['HTTPS://WWW.INSTAGRAM.COM/p/ABCdef12345/', 'post', 'ABCdef12345'],
  ];
  for (const [input, type, shortcode] of ok) {
    const r = parseInstagramUrl(input);
    assert.equal(r.ok, true, input);
    assert.equal(r.type, type, input);
    assert.equal(r.shortcode, shortcode, input);
    assert.match(r.canonicalUrl, /^https:\/\/www\.instagram\.com\/(p|reel|tv)\/[\w-]+\/$/);
  }
});

test('rejects invalid input with a useful code', () => {
  const bad = [
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    [null, 'EMPTY'],
    [undefined, 'EMPTY'],
    [42, 'EMPTY'],
    ['not a url', 'INVALID_URL'],
    ['two https://a.com https://b.com', 'INVALID_URL'],
    ['https://example.com/p/ABCdef12345/', 'NOT_INSTAGRAM'],
    ['https://instagram.com.evil.com/p/ABCdef12345/', 'NOT_INSTAGRAM'],
    ['https://evil.com/?u=instagram.com/p/ABCdef12345/', 'NOT_INSTAGRAM'],
    ['https://www.instagram.com@evil.com/p/ABCdef12345/', 'INVALID_URL'],
    ['https://user:pw@www.instagram.com/p/ABCdef12345/', 'INVALID_URL'],
    ['https://www.instagram.com:8443/p/ABCdef12345/', 'INVALID_URL'],
    ['ftp://www.instagram.com/p/ABCdef12345/', 'INVALID_URL'],
    ['javascript:alert(1)', 'INVALID_URL'],
    ['https://www.instagram.com/', 'UNSUPPORTED_URL'],
    ['https://www.instagram.com/someuser/', 'UNSUPPORTED_URL'],
    ['https://www.instagram.com/stories/someuser/123/', 'UNSUPPORTED_URL'],
    ['https://www.instagram.com/explore/tags/cats/', 'UNSUPPORTED_URL'],
    ['https://www.instagram.com/p/', 'UNSUPPORTED_URL'],
    ['https://www.instagram.com/p/ab/', 'INVALID_URL'],
    ['https://www.instagram.com/p/abc$%^&*()def/', 'INVALID_URL'],
    ['https://www.instagram.com/p/' + 'a'.repeat(3000), 'INVALID_URL'],
  ];
  for (const [input, code] of bad) {
    const r = parseInstagramUrl(input);
    assert.equal(r.ok, false, String(input));
    assert.equal(r.code, code, String(input));
    assert.ok(r.message.length > 5);
  }
});
