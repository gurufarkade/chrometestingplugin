// Runs in the page's MAIN world at document_start. Wraps fetch/XMLHttpRequest
// (and console errors) so API calls can be captured with full request and
// response bodies. Talks to the isolated content script via window.postMessage.
(() => {
  if (window.__qaRecorderHook) return;
  window.__qaRecorderHook = true;

  const CH = '__qa_recorder__';
  // enabled === null means "not told yet": capture so early page-load requests
  // are not lost; the content script drops them if the tab is not recording.
  const cfg = { enabled: null, bodies: true, maxBody: 100000, console: true };
  let seq = 0;

  const post = (type, data) => {
    try {
      window.postMessage({ [CH]: true, dir: 'from-page', type, data }, '*');
    } catch {
      /* uncloneable payload */
    }
  };
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || !d[CH] || d.dir !== 'to-page') return;
    if (d.type === 'config') Object.assign(cfg, d.data);
  });
  const on = () => cfg.enabled !== false;

  const TEXT_TYPES = /json|text|xml|javascript|x-www-form-urlencoded|graphql|html|csv/i;

  function truncate(s) {
    if (s == null) return { body: null, truncated: false };
    s = String(s);
    if (s.length > cfg.maxBody) return { body: s.slice(0, cfg.maxBody), truncated: true };
    return { body: s, truncated: false };
  }

  function serializeBody(body) {
    if (body == null) return null;
    try {
      if (typeof body === 'string') return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const o = {};
        for (const [k, v] of body.entries()) o[k] = typeof v === 'string' ? v : `[File ${v.name} ${v.size}b]`;
        return JSON.stringify(o);
      }
      if (body instanceof Blob) return `[Blob ${body.type || ''} ${body.size}b]`;
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[binary ${body.byteLength}b]`;
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return '[stream]';
      return String(body);
    } catch {
      return '[unserializable]';
    }
  }

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    try {
      if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k] = v));
      else Object.entries(h).forEach(([k, v]) => (out[k] = String(v)));
    } catch {}
    return out;
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url);
    }
  }

  // ------------------------------------------------------------- fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function qaFetch(input, init) {
      if (!on()) return origFetch.apply(this, arguments);
      const id = `f${++seq}_${Date.now()}`;
      const entry = { id, api: 'fetch', startTime: Date.now(), pageUrl: location.href };
      const t0 = performance.now();
      try {
        const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
        entry.url = absolute(req ? req.url : input instanceof URL ? input.href : input);
        entry.method = String(init?.method || req?.method || 'GET').toUpperCase();
        entry.requestHeaders = { ...headersToObject(req?.headers), ...headersToObject(init?.headers) };
        entry.requestBody = init && 'body' in init ? serializeBody(init.body) : req && req.method !== 'GET' ? '[Request body]' : null;
      } catch {}
      post('net-start', { id });
      let p;
      try {
        p = origFetch.apply(this, arguments);
      } catch (err) {
        post('net-end', { ...entry, error: String(err), duration: 0, status: 0 });
        throw err;
      }
      p.then(
        async (res) => {
          entry.status = res.status;
          entry.statusText = res.statusText;
          entry.responseHeaders = headersToObject(res.headers);
          entry.mimeType = res.headers.get('content-type') || '';
          entry.redirected = res.redirected;
          entry.responseUrl = res.url;
          entry.duration = Math.round(performance.now() - t0);
          if (cfg.bodies && TEXT_TYPES.test(entry.mimeType) && !/event-stream/i.test(entry.mimeType)) {
            try {
              const text = await Promise.race([res.clone().text(), new Promise((r) => setTimeout(() => r('[body read timeout]'), 10000))]);
              const t = truncate(text);
              entry.responseBody = t.body;
              entry.bodyTruncated = t.truncated;
            } catch (e) {
              entry.responseBody = `[unreadable: ${e}]`;
            }
          }
          entry.endTime = Date.now();
          post('net-end', entry);
        },
        (err) => {
          entry.status = 0;
          entry.error = String(err && err.message ? err.message : err);
          entry.duration = Math.round(performance.now() - t0);
          entry.endTime = Date.now();
          post('net-end', entry);
        },
      );
      return p;
    };
  }

  // ------------------------------------------------------------- XHR
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const origOpen = XHR.open;
    const origSend = XHR.send;
    const origSetHeader = XHR.setRequestHeader;
    XHR.open = function (method, url) {
      this.__qa = { method: String(method).toUpperCase(), url: absolute(url), headers: {} };
      return origOpen.apply(this, arguments);
    };
    XHR.setRequestHeader = function (k, v) {
      if (this.__qa) this.__qa.headers[k] = v;
      return origSetHeader.apply(this, arguments);
    };
    XHR.send = function (body) {
      const meta = this.__qa;
      if (!meta || !on()) return origSend.apply(this, arguments);
      const id = `x${++seq}_${Date.now()}`;
      const t0 = performance.now();
      const entry = {
        id,
        api: 'xhr',
        method: meta.method,
        url: meta.url,
        requestHeaders: meta.headers,
        requestBody: serializeBody(body),
        startTime: Date.now(),
        pageUrl: location.href,
      };
      post('net-start', { id });
      this.addEventListener('loadend', () => {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.duration = Math.round(performance.now() - t0);
        entry.endTime = Date.now();
        entry.responseUrl = this.responseURL;
        const headers = {};
        (this.getAllResponseHeaders() || '')
          .trim()
          .split(/[\r\n]+/)
          .forEach((line) => {
            const i = line.indexOf(':');
            if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
          });
        entry.responseHeaders = headers;
        entry.mimeType = headers['content-type'] || '';
        if (this.status === 0) entry.error = 'Network error / aborted';
        if (cfg.bodies) {
          try {
            let text = null;
            if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
            else if (this.responseType === 'json') text = JSON.stringify(this.response);
            else text = `[${this.responseType}]`;
            const t = truncate(text);
            entry.responseBody = t.body;
            entry.bodyTruncated = t.truncated;
          } catch {}
        }
        post('net-end', entry);
      });
      return origSend.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------- console
  function fmt(a) {
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a).slice(0, 2000);
    } catch {
      return String(a);
    }
  }
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = function (...args) {
      if (on() && cfg.console) {
        const err = args.find((a) => a instanceof Error);
        post('console', { level, message: args.map(fmt).join(' ').slice(0, 4000), stack: err?.stack?.slice(0, 4000), ts: Date.now(), url: location.href });
      }
      return orig.apply(this, args);
    };
  }
  window.addEventListener('error', (e) => {
    if (!on() || !cfg.console) return;
    if (e.target && e.target !== window && e.target.tagName) {
      post('console', { level: 'error', message: `Failed to load resource: <${e.target.tagName.toLowerCase()}> ${e.target.src || e.target.href || ''}`, ts: Date.now(), url: location.href });
      return;
    }
    post('console', { level: 'error', message: `Uncaught ${e.message}`, stack: e.error?.stack?.slice(0, 4000), source: `${e.filename}:${e.lineno}:${e.colno}`, ts: Date.now(), url: location.href });
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    if (!on() || !cfg.console) return;
    post('console', { level: 'error', message: `Unhandled promise rejection: ${fmt(e.reason)}`, stack: e.reason?.stack?.slice(0, 4000), ts: Date.now(), url: location.href });
  });
})();
