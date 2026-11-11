/* InstaSave front-end. No frameworks: plain, dependency-free JavaScript. */
(() => {
  'use strict';

  const { parseInstagramUrl } = window.InstaValidators;
  const $ = (sel, root = document) => root.querySelector(sel);
  const state = { config: null, session: { connected: false } };

  /* ------------------------------ small helpers ------------------------------ */

  class ApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  /** Create an element. Text is always inserted as text (never as HTML). */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function icon(name, cls = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `icon ${cls}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  const formatBytes = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

  async function api(path, { method = 'GET', json } = {}) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      throw new ApiError('NETWORK', 'Network error. Please check your connection and try again.', 0);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (!res.ok) {
      throw new ApiError(data?.error?.code || 'ERROR', data?.error?.message || `Request failed (${res.status}).`, res.status);
    }
    return data;
  }

  /** Upload with progress (fetch cannot report upload progress). */
  function uploadFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name.slice(0, 200)));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onerror = () => reject(new ApiError('NETWORK', 'Network error during upload. Please try again.', 0));
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(data?.error?.code || 'ERROR', data?.error?.message || `Upload failed (${xhr.status}).`, xhr.status));
      };
      xhr.send(file);
    });
  }

  /* -------------------------------- messages --------------------------------- */

  const messageBox = $('#message');
  function showMessage(kind, text) {
    messageBox.replaceChildren();
    if (!text) {
      messageBox.hidden = true;
      return;
    }
    messageBox.className = `message is-${kind}`;
    messageBox.append(icon(kind === 'success' ? 'check' : 'alert'), el('span', { text }));
    messageBox.hidden = false;
  }

  function setBusy(button, busy) {
    button.disabled = busy;
    button.classList.toggle('is-loading', busy);
    button.setAttribute('aria-busy', String(busy));
  }

  /* --------------------------------- results --------------------------------- */

  const results = $('#results');
  const clearResults = () => results.replaceChildren();
  const downloadLink = (href, label, cls = 'btn btn-primary') =>
    el('a', { class: cls, href, download: '' }, icon('download'), el('span', { text: label }));

  function renderInstagram(data) {
    clearResults();
    const typeLabel = { reel: 'Reel', video: 'Video', post: data.carousel ? 'Carousel' : 'Post' }[data.type] || 'Post';
    const tiles = data.items.map((item) => {
      const isVideo = item.mediaType === 'VIDEO';
      const media = isVideo
        ? el('video', { src: item.previewUrl, poster: item.posterUrl, controls: true, playsinline: true, preload: 'metadata' })
        : el('img', { src: item.previewUrl, alt: `Preview of slide ${item.index}`, loading: 'lazy' });
      return el(
        'div',
        { class: 'media-tile' },
        el('div', { class: 'media-frame' }, media),
        el(
          'div',
          { class: 'media-meta' },
          el('div', { class: 'media-meta-top' }, el('span', { class: 'name', text: data.items.length > 1 ? `Slide ${item.index}` : isVideo ? 'Video' : 'Photo' }), el('span', { class: 'chips' }, ...item.formats.map((f) => el('span', { class: 'chip', text: f })))),
          downloadLink(item.downloadUrl, isVideo ? 'Download video' : 'Download photo')
        )
      );
    });
    const head = el(
      'div',
      { class: 'result-head' },
      el('div', { class: 'result-title' }, icon(data.carousel ? 'layers' : data.type === 'post' ? 'image' : 'video'), el('span', { text: 'Ready to download' }), el('span', { class: 'badge', text: typeLabel })),
      data.items.length > 1
        ? el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => downloadAll(data.items) }, icon('download'), el('span', { text: `Download all (${data.items.length})` }))
        : null
    );
    results.append(el('div', { class: 'card result-card' }, head, el('div', { class: `media-grid${tiles.length === 1 ? ' single' : ''}` }, ...tiles)));
    results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function downloadAll(items) {
    items.forEach((item, i) =>
      setTimeout(() => {
        const a = el('a', { href: item.downloadUrl, download: '' });
        document.body.append(a);
        a.click();
        a.remove();
      }, i * 500)
    );
    showMessage('success', 'Starting downloads. If your browser asks, allow multiple downloads.');
  }

  function fileTile(file, { withConvert }) {
    let media;
    if (file.kind === 'image') media = el('img', { src: file.previewUrl, alt: `Preview of ${file.name}` });
    else if (file.kind === 'video') media = el('video', { src: file.previewUrl, controls: true, playsinline: true, preload: 'metadata' });
    else media = el('audio', { src: file.previewUrl, controls: true });

    const meta = el(
      'div',
      { class: 'media-meta' },
      el('div', { class: 'media-meta-top' }, el('span', { class: 'name', title: file.name, text: file.name }), el('span', { class: 'chips' }, el('span', { class: 'chip', text: file.ext.toUpperCase() }), el('span', { class: 'chip', text: formatBytes(file.size) }))),
      downloadLink(file.downloadUrl, 'Download')
    );

    if (withConvert && file.convertTo.length) {
      const select = el('select', { 'aria-label': 'Convert to' }, ...file.convertTo.map((f) => el('option', { value: f, text: `Convert to ${f.toUpperCase()}` })));
      const converted = el('div', { class: 'converted' });
      const btn = el('button', { class: 'btn btn-secondary', type: 'button' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), icon('refresh', 'btn-icon'), el('span', { class: 'btn-label', text: 'Convert' }));
      btn.addEventListener('click', async () => {
        setBusy(btn, true);
        showMessage('info', 'Converting… large videos can take a little while.');
        try {
          const out = await api('/api/convert', { method: 'POST', json: { id: file.id, format: select.value } });
          converted.append(fileTile(out, { withConvert: false }));
          showMessage('success', `Converted to ${out.ext.toUpperCase()}.`);
        } catch (err) {
          showMessage('error', err.message);
        } finally {
          setBusy(btn, false);
        }
      });
      meta.append(el('div', { class: 'convert-row' }, select, btn), converted);
    }
    return el('div', { class: 'media-tile' }, el('div', { class: 'media-frame' }, media), meta);
  }

  function renderUpload(file) {
    clearResults();
    const head = el('div', { class: 'result-head' }, el('div', { class: 'result-title' }, icon('check'), el('span', { text: 'File ready' }), el('span', { class: 'badge', text: `Deleted after ${state.config?.upload.ttlMinutes ?? 30} min` })));
    results.append(el('div', { class: 'card result-card' }, head, el('div', { class: 'media-grid single' }, fileTile(file, { withConvert: true }))));
    results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ------------------------------ Instagram link ----------------------------- */

  const form = $('#urlForm');
  const input = $('#urlInput');
  const submitBtn = $('#submitBtn');
  const connectBar = $('#connectBar');

  function renderConnectBar() {
    connectBar.replaceChildren();
    const ig = state.config?.instagram;
    if (!ig) {
      connectBar.hidden = true;
      return;
    }
    connectBar.hidden = false;
    if (!ig.enabled) {
      connectBar.append(el('span', { text: 'Instagram connection is not set up on this server. Link downloads are unavailable, but the upload tool works.' }));
    } else if (state.session.connected) {
      connectBar.append(
        el('span', {}, 'Connected as ', el('strong', { text: `@${state.session.username}` })),
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          onclick: async () => {
            await api('/api/logout', { method: 'POST', json: {} }).catch(() => {});
            state.session = { connected: false };
            clearResults();
            showMessage('info', 'Disconnected from Instagram.');
            renderConnectBar();
          },
        }, 'Disconnect')
      );
    } else {
      connectBar.append(
        el('span', {}, 'To download your own posts, ', el('strong', { text: 'connect your Instagram account' }), ' (official sign-in; we never see your password).'),
        el('a', { class: 'btn btn-primary', href: '/auth/instagram' }, icon('instagram'), el('span', { text: 'Connect Instagram' }))
      );
    }
  }

  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    if (messageBox.classList.contains('is-error')) showMessage('', '');
  });

  $('#pasteBtn').addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.readText) throw new Error('unsupported');
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return showMessage('info', 'Your clipboard is empty. Copy an Instagram link first.');
      input.value = text;
      input.dispatchEvent(new Event('input'));
      input.focus();
    } catch {
      input.focus();
      showMessage('info', 'Your browser blocked clipboard access. Please paste the link manually (Ctrl/⌘ + V).');
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearResults();
    const parsed = parseInstagramUrl(input.value);
    if (!parsed.ok) {
      input.setAttribute('aria-invalid', 'true');
      showMessage('error', parsed.message);
      input.focus();
      return;
    }
    input.value = parsed.canonicalUrl;
    setBusy(submitBtn, true);
    showMessage('info', 'Looking up your media…');
    try {
      const data = await api('/api/resolve', { method: 'POST', json: { url: parsed.canonicalUrl } });
      showMessage('success', data.items.length > 1 ? `Found ${data.items.length} items in this carousel.` : 'Found your media.');
      renderInstagram(data);
    } catch (err) {
      showMessage('error', err.message);
      if (err.code === 'AUTH_REQUIRED' || err.code === 'AUTH_EXPIRED') {
        state.session = { connected: false };
        renderConnectBar();
        connectBar.classList.remove('needs-attention');
        void connectBar.offsetWidth; // restart animation
        connectBar.classList.add('needs-attention');
      }
    } finally {
      setBusy(submitBtn, false);
    }
  });

  /* --------------------------------- uploads --------------------------------- */

  const dropZone = $('#dropZone');
  const fileInput = $('#fileInput');
  const progress = $('#uploadProgress');
  const progressBar = $('#progressBar');

  async function handleFile(file) {
    if (!file) return;
    clearResults();
    const maxMb = state.config?.upload.maxMb;
    if (maxMb && file.size > maxMb * 1048576) return showMessage('error', `That file is ${formatBytes(file.size)}. The limit is ${maxMb} MB.`);
    if (file.size === 0) return showMessage('error', 'That file is empty.');
    progress.hidden = false;
    progressBar.style.width = '0%';
    showMessage('info', `Uploading ${file.name}…`);
    try {
      const data = await uploadFile(file, (p) => {
        const pct = Math.round(p * 100);
        progressBar.style.width = `${pct}%`;
        progress.setAttribute('aria-valuenow', String(pct));
      });
      showMessage('success', 'Upload complete.');
      renderUpload(data);
    } catch (err) {
      showMessage('error', err.message);
    } finally {
      progress.hidden = true;
      fileInput.value = '';
    }
  }

  fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
  ['dragenter', 'dragover'].forEach((t) => dropZone.addEventListener(t, (e) => { e.preventDefault(); dropZone.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((t) => dropZone.addEventListener(t, (e) => { e.preventDefault(); dropZone.classList.remove('is-over'); }));
  dropZone.addEventListener('drop', (e) => handleFile(e.dataTransfer?.files?.[0]));

  /* ----------------------------------- tabs ---------------------------------- */

  const tabs = [...document.querySelectorAll('.tab')];
  function selectTab(tab) {
    tabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
      $(`#panel-${t.dataset.tab}`).hidden = !active;
    });
    showMessage('', '');
    clearResults();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      selectTab(next);
    });
  });

  /* ---------------------------- navigation & polish --------------------------- */

  const nav = $('#nav');
  const navToggle = $('#navToggle');
  navToggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      nav.classList.remove('is-open');
      navToggle.setAttribute('aria-expanded', 'false');
    }
  });

  document.documentElement.classList.add('js');
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
    }), { threshold: 0.12 });
    reveals.forEach((r) => io.observe(r));
  } else {
    reveals.forEach((r) => r.classList.add('is-visible'));
  }

  /* ----------------------------------- init ---------------------------------- */

  const AUTH_ERRORS = {
    denied: 'Instagram authorization was cancelled.',
    state: 'The sign-in could not be verified. Please try connecting again.',
    failed: 'Instagram sign-in failed. Please try again.',
    not_configured: 'Instagram connection is not set up on this server.',
  };

  async function init() {
    const params = new URLSearchParams(location.search);
    try {
      state.config = await api('/api/config');
      state.session = await api('/api/session');
    } catch (err) {
      showMessage('error', err.message);
    }
    const contact = $('#contactLink');
    if (state.config?.contactEmail) {
      contact.href = `mailto:${state.config.contactEmail}`;
      contact.hidden = false;
    }
    renderConnectBar();
    if (state.config) {
      $('#dzHint').textContent = `JPG, PNG, WebP, GIF, MP4, MOV or WebM · up to ${state.config.upload.maxMb} MB`;
    }
    if (params.get('connected') === '1' && state.session.connected) showMessage('success', `Connected as @${state.session.username}. Paste a link to one of your posts.`);
    if (params.get('auth_error')) showMessage('error', AUTH_ERRORS[params.get('auth_error')] || AUTH_ERRORS.failed);
    if (params.has('connected') || params.has('auth_error')) history.replaceState(null, '', location.pathname + location.hash);
  }

  init();
})();
