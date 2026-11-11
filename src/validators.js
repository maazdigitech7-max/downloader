/**
 * Instagram URL validation. Shared by the browser (window.InstaValidators)
 * and the server (require), so both always apply identical rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InstaValidators = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HOSTS = new Set([
    'instagram.com',
    'www.instagram.com',
    'm.instagram.com',
    'instagr.am',
    'www.instagr.am',
  ]);
  const KINDS = { p: 'post', reel: 'reel', reels: 'reel', tv: 'video' };
  const SHORTCODE = /^[A-Za-z0-9_-]{5,40}$/;

  const fail = (code, message) => ({ ok: false, code, message });

  /**
   * @param {string} input what the user pasted
   * @returns {{ok:true,type:string,shortcode:string,canonicalUrl:string}|{ok:false,code:string,message:string}}
   */
  function parseInstagramUrl(input) {
    if (typeof input !== 'string' || !input.trim()) {
      return fail('EMPTY', 'Please paste an Instagram link first.');
    }
    let raw = input.trim();
    if (raw.length > 2048) return fail('INVALID_URL', 'That link is too long to be valid.');
    if (/\s/.test(raw)) return fail('INVALID_URL', 'Please paste a single Instagram link.');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;

    let url;
    try {
      url = new URL(raw);
    } catch {
      return fail('INVALID_URL', 'That does not look like a valid link.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return fail('INVALID_URL', 'Only http(s) links are supported.');
    }
    if (url.username || url.password || url.port) {
      return fail('INVALID_URL', 'That does not look like a valid Instagram link.');
    }
    if (!HOSTS.has(url.hostname.toLowerCase())) {
      return fail('NOT_INSTAGRAM', 'Only instagram.com links are supported.');
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'stories') {
      return fail('UNSUPPORTED_URL', 'Stories are not supported. Paste a post, reel or video link.');
    }
    // Accept /p/CODE, /reel/CODE, /tv/CODE and /username/p/CODE
    const offset = parts.length >= 3 && !Object.hasOwn(KINDS, parts[0]) ? 1 : 0;
    const kind = parts[offset];
    const shortcode = parts[offset + 1];
    if (!Object.hasOwn(KINDS, kind) || !shortcode) {
      return fail(
        'UNSUPPORTED_URL',
        'This link is not a post, reel or video. Profile, story and explore links are not supported.'
      );
    }
    if (!SHORTCODE.test(shortcode)) {
      return fail('INVALID_URL', 'The post ID in that link looks malformed.');
    }
    const canonicalKind = kind === 'reels' ? 'reel' : kind;
    return {
      ok: true,
      type: KINDS[kind],
      shortcode,
      canonicalUrl: `https://www.instagram.com/${canonicalKind}/${shortcode}/`,
    };
  }

  return { parseInstagramUrl };
});
