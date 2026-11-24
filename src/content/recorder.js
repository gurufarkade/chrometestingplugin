// Isolated-world content script: turns user interactions into semantic steps,
// relays API/console events from the page hook, and serves replay requests.
(() => {
  const QA = (globalThis.QA = globalThis.QA || {});
  if (QA.recorderLoaded) return;
  QA.recorderLoaded = true;

  const CH = '__qa_recorder__';
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'time', 'month', 'week', 'color', 'range']);
  const SENSITIVE_RE = /pass(word|code)?|pwd|secret|otp|pin\b|cvv|cvc|card.?number|ssn|token|api.?key/i;

  let config = { mode: 'off', settings: {}, counts: {} };
  let known = false; // config received from background yet?
  const buffered = []; // hook events received before config is known
  const inflight = new Set();
  let lastFill = null; // { el, cid }
  let lastClick = null; // { el, cid, ts }

  const recording = () => config.mode === 'record';
  const capturingNetwork = () => config.mode === 'record' || config.mode === 'replay';
  const uid = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension reloaded: context invalidated
    }
  }

  function applyConfig(c) {
    config = c || config;
    known = true;
    window.postMessage(
      {
        [CH]: true,
        dir: 'to-page',
        type: 'config',
        data: {
          enabled: capturingNetwork(),
          bodies: config.settings?.captureResponseBodies !== false,
          maxBody: config.settings?.maxBodyBytes || 100000,
          console: config.settings?.captureConsole !== false,
        },
      },
      '*',
    );
    if (buffered.length) {
      const items = buffered.splice(0);
      if (capturingNetwork()) items.forEach(forwardHookEvent);
    }
    if (config.mode !== 'record') stopAssertHover();
    else if (config.assertMode) startAssertHover();
    else stopAssertHover();
    QA.overlay.render({ ...config, show: config.settings?.showOverlay !== false });
  }

  // ------------------------------------------------------------ page hook bridge

  function forwardHookEvent({ type, data }) {
    if (type === 'net-end') send({ type: 'content:event', kind: 'network', entry: data });
    else if (type === 'console') send({ type: 'content:event', kind: 'console', entry: data });
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || !d[CH] || d.dir !== 'from-page') return;
    if (d.type === 'net-start') {
      inflight.add(d.data.id);
      return;
    }
    if (d.type === 'net-end') inflight.delete(d.data.id);
    if (!known) {
      if (buffered.length < 500) buffered.push(d);
      return;
    }
    if (capturingNetwork()) forwardHookEvent(d);
  });

  // ------------------------------------------------------------ step helpers

  function baseStep(action, el, extra = {}) {
    return {
      action,
      target: el ? QA.sel.describe(el) : undefined,
      url: location.href,
      title: document.title,
      ts: Date.now(),
      ...extra,
    };
  }

  function emit(step, { op = 'add', cid = uid(), screenshot = true, screenshotDelay } = {}) {
    send({ type: 'content:event', kind: 'step', op, cid, step, screenshot, screenshotDelay }).then((res) => {
      if (res?.counts) {
        config.counts = res.counts;
        QA.overlay.render({ ...config, show: config.settings?.showOverlay !== false });
      }
    });
    return cid;
  }

  function isTextLike(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el instanceof HTMLTextAreaElement) return true;
    return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
  }

  function isSensitive(el) {
    if (el instanceof HTMLInputElement && el.type === 'password') return true;
    const hay = [el.name, el.id, el.getAttribute?.('autocomplete'), el.getAttribute?.('aria-label'), el.placeholder].join(' ');
    return SENSITIVE_RE.test(hay) && !/user|email|login/i.test(hay);
  }

  function toggleTarget(el) {
    // A click on a <label> (or inside one) for a checkbox/radio is recorded via 'change'.
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el;
    const label = el.closest?.('label');
    const ctl = label?.control;
    if (ctl && (ctl.type === 'checkbox' || ctl.type === 'radio')) return ctl;
    return null;
  }

  function deepTarget(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.find((n) => n.nodeType === 1) || e.target;
  }

  // ------------------------------------------------------------ listeners

  function onClick(e) {
    if (!recording() || !e.isTrusted || QA.overlay.isOverlayEvent(e)) return;
    if (config.assertMode) return; // handled by assert handler
    const raw = deepTarget(e);
    if (toggleTarget(raw)) return;
    const el = QA.sel.actionableTarget(raw);
    if (!el || el === document.documentElement || el === document.body) return;
    if (el instanceof HTMLSelectElement || el instanceof HTMLOptionElement) return; // recorded via change
    if (isTextLike(el)) return; // focusing a field — the fill step covers it
    if (e.detail >= 2) return; // second click of a double-click
    const cid = emit(baseStep('click', el, { button: e.button === 2 ? 'right' : 'left', modifiers: mods(e) }));
    lastClick = { el, cid, ts: Date.now() };
  }

  function onDblClick(e) {
    if (!recording() || !e.isTrusted || QA.overlay.isOverlayEvent(e) || config.assertMode) return;
    const el = QA.sel.actionableTarget(deepTarget(e));
    if (lastClick && lastClick.el === el && Date.now() - lastClick.ts < 800) {
      emit({ action: 'dblclick' }, { op: 'update', cid: lastClick.cid });
    } else {
      emit(baseStep('dblclick', el));
    }
  }

  function onContextMenu(e) {
    if (!recording() || !e.isTrusted || QA.overlay.isOverlayEvent(e)) return;
    const el = QA.sel.actionableTarget(deepTarget(e));
    if (el) emit(baseStep('click', el, { button: 'right' }));
  }

  function onInput(e) {
    if (!recording() || !e.isTrusted) return;
    const el = deepTarget(e);
    if (!isTextLike(el)) return;
    const value = el.isContentEditable ? el.innerText : el.value;
    if (lastFill && lastFill.el === el) {
      emit({ value }, { op: 'update', cid: lastFill.cid, screenshot: false });
      return;
    }
    const sensitive = isSensitive(el);
    const cid = emit(baseStep('fill', el, { value, sensitive }), { screenshot: false });
    lastFill = { el, cid };
  }

  function onChange(e) {
    if (!recording() || !e.isTrusted) return;
    const el = deepTarget(e);
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      emit(baseStep(el.checked ? 'check' : 'uncheck', el));
      return;
    }
    if (el instanceof HTMLSelectElement) {
      const selected = Array.from(el.selectedOptions);
      emit(
        baseStep('select', el, {
          value: el.value,
          values: selected.map((o) => o.value),
          optionLabels: selected.map((o) => QA.sel.norm(o.textContent)),
        }),
      );
      return;
    }
    if (el instanceof HTMLInputElement && el.type === 'file') {
      emit(baseStep('upload', el, { files: Array.from(el.files || []).map((f) => ({ name: f.name, size: f.size, type: f.type })) }));
      return;
    }
    if (isTextLike(el) && lastFill && lastFill.el === el) {
      // committed value (blur) — refresh value and grab a screenshot
      emit({ value: el.isContentEditable ? el.innerText : el.value }, { op: 'update', cid: lastFill.cid, screenshot: true, screenshotDelay: 50 });
    }
  }

  function mods(e) {
    const m = {};
    if (e.ctrlKey) m.ctrl = true;
    if (e.shiftKey) m.shift = true;
    if (e.altKey) m.alt = true;
    if (e.metaKey) m.meta = true;
    return Object.keys(m).length ? m : undefined;
  }

  function onKeyDown(e) {
    if (!e.isTrusted || QA.overlay.isOverlayEvent(e)) return;
    if (config.assertMode && e.key === 'Escape') {
      send({ type: 'content:control', action: 'assertMode', on: false });
      return;
    }
    if (!recording()) return;
    const el = deepTarget(e);
    if (el instanceof HTMLSelectElement) return; // keyboard use of a native dropdown is captured by 'change'
    const inText = isTextLike(el);
    const combo = e.ctrlKey || e.metaKey || e.altKey;
    const comboable = el.getAttribute?.('role') === 'combobox' || el.getAttribute?.('aria-autocomplete') || el.getAttribute?.('list');
    let record = false;
    if (e.key === 'Enter' && !(el instanceof HTMLTextAreaElement && !combo)) record = true;
    else if (e.key === 'Escape') record = true;
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && comboable) record = true;
    else if (combo && e.key.length === 1 && !(inText && /^[acvxzy]$/i.test(e.key))) record = true;
    if (!record) return;
    if (lastFill && lastFill.el === el) lastFill = { ...lastFill, closed: true };
    emit(baseStep('press', el === document.body ? null : el, { key: e.key, modifiers: mods(e) }), { screenshotDelay: 500 });
  }

  // Reset fill-merging when focus moves to a different field.
  function onFocusIn(e) {
    if (lastFill && lastFill.el !== deepTarget(e)) lastFill = null;
  }

  // ------------------------------------------------------------ assert mode

  let hoverEl = null;
  function assertHover(e) {
    if (QA.overlay.isOverlayEvent(e)) return;
    const el = QA.sel.actionableTarget(deepTarget(e)) || deepTarget(e);
    hoverEl = el;
    const kind = proposeAssertion(el, e.shiftKey);
    QA.overlay.highlight(el, { kind: 'assert', label: `Assert ${kind.type}${kind.expected !== undefined ? `: "${String(kind.expected).slice(0, 50)}"` : ''} · Shift = visible only · Esc = cancel` });
  }
  function assertClick(e) {
    if (!config.assertMode || QA.overlay.isOverlayEvent(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = QA.sel.actionableTarget(deepTarget(e)) || deepTarget(e);
    const assertion = proposeAssertion(el, e.shiftKey);
    emit(baseStep('assert', el, { assert: assertion }));
    QA.overlay.toast(`✓ Assertion added: ${assertion.type}`);
    QA.overlay.clearHighlight();
  }
  function swallow(e) {
    if (!config.assertMode || QA.overlay.isOverlayEvent(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function proposeAssertion(el, visibleOnly) {
    if (visibleOnly) return { type: 'visible' };
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return { type: 'checked', expected: el.checked };
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return { type: 'value', expected: el.value };
    const text = QA.sel.textOf(el);
    if (text && text.length <= 150) return { type: 'text', expected: text };
    return { type: 'visible' };
  }
  let assertOn = false;
  function startAssertHover() {
    if (assertOn) return;
    assertOn = true;
    document.addEventListener('mousemove', assertHover, true);
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) window.addEventListener(t, swallow, true);
    window.addEventListener('click', assertClick, true);
  }
  function stopAssertHover() {
    if (!assertOn) return;
    assertOn = false;
    document.removeEventListener('mousemove', assertHover, true);
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) window.removeEventListener(t, swallow, true);
    window.removeEventListener('click', assertClick, true);
    QA.overlay.clearHighlight();
    hoverEl = null;
  }

  window.addEventListener('click', onClick, true);
  window.addEventListener('dblclick', onDblClick, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('input', onInput, true);
  window.addEventListener('change', onChange, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('focusin', onFocusIn, true);

  // ------------------------------------------------------------ overlay buttons

  QA.overlay.onAction = (act) => {
    if (act === 'pause') send({ type: 'content:control', action: config.mode === 'paused' ? 'resume' : 'pause' });
    if (act === 'stop') send({ type: 'content:control', action: config.mode === 'replay' ? 'stopReplay' : 'stop' });
    if (act === 'assert') send({ type: 'content:control', action: 'assertMode' });
    if (act === 'screenshot') send({ type: 'content:control', action: 'screenshot' }).then(() => QA.overlay.toast('📷 Evidence captured'));
  };

  // ------------------------------------------------------------ background messages

  function environment() {
    return {
      userAgent: navigator.userAgent,
      platform: navigator.userAgentData?.platform || navigator.platform,
      language: navigator.language,
      languages: navigator.languages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewport: { width: innerWidth, height: innerHeight },
      screen: { width: screen.width, height: screen.height },
      devicePixelRatio,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      url: location.href,
      title: document.title,
      referrer: document.referrer,
    };
  }

  async function waitIdle(timeoutMs) {
    const end = Date.now() + timeoutMs;
    let quietSince = inflight.size ? 0 : Date.now();
    while (Date.now() < end) {
      if (inflight.size === 0) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= 500) return { idle: true };
      } else quietSince = 0;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { idle: false, inflight: inflight.size };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'ping':
        sendResponse({ ok: true, url: location.href, readyState: document.readyState });
        return false;
      case 'env':
        sendResponse(environment());
        return false;
      case 'config':
        applyConfig(msg.config);
        sendResponse({ ok: true });
        return false;
      case 'overlay:visibility':
        QA.overlay.setHidden(!msg.visible);
        sendResponse({ ok: true });
        return false;
      case 'replay:exec':
        QA.replay
          .exec(msg.step, msg.options)
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
        return true;
      case 'replay:waitIdle':
        waitIdle(msg.timeoutMs || 5000).then(sendResponse);
        return true;
      case 'replay:done':
        QA.overlay.toast(msg.status === 'passed' ? '✅ Replay passed' : msg.status === 'cancelled' ? '⏹ Replay cancelled' : '❌ Replay failed — see dashboard', 4000);
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  send({ type: 'content:ready' }).then((c) => applyConfig(c || { mode: 'off', settings: {} }));
})();
