// Recorder — the DOM adapter. Turns browser events into Interaction facts for
// the Step builder, starts the Outcome observer after each Step, relays API
// and console events from the page hook, and serves replay requests.
// Runs in every frame; only the top frame shows the overlay.
(() => {
  const QA = (globalThis.QA = globalThis.QA || {});
  if (QA.recorderLoaded) return;
  QA.recorderLoaded = true;

  const CH = '__qa_recorder__';
  const IS_TOP = window.top === window;
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'time', 'month', 'week', 'color', 'range']);
  const SENSITIVE_RE = /pass(word|code)?|pwd|secret|otp|one.?time|\bpin\b|cvv|cvc|card.?number|ssn|token|api.?key/i;
  // Popup containers revealed by hovering (menus, dropdowns, flyouts, mega-menus)
  const MENU_SELECTOR = [
    '[role="menu"]', '[role="listbox"]', '[role="tooltip"]', 'ul ul', 'nav ul ul', '.dropdown-menu',
    '[class*="dropdown" i] > ul', '[class*="menu" i] > ul', '[class*="dropdown-content" i]', '[class*="submenu" i]',
    '[class*="sub-menu" i]', '[class*="flyout" i]', '[class*="popover" i]', '[class*="mega" i]',
  ].join(', ');
  const OUTCOME_ACTIONS = new Set(['click', 'dblclick', 'press', 'select', 'check', 'uncheck', 'drag', 'fill']);

  let config = { mode: 'off', settings: {}, counts: {} };
  let known = false;
  const buffered = [];
  const inflight = new Set();
  const frame = QA.sel.frameInfo();

  const recording = () => config.mode === 'record';
  const capturingNetwork = () => config.mode === 'record' || config.mode === 'replay';
  const render = () => IS_TOP && QA.overlay.render({ ...config, show: config.settings?.showOverlay !== false });

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension reloaded: context invalidated
    }
  }

  // ------------------------------------------------------------ config + page hook bridge

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
    if (config.mode === 'record' && config.assertMode) startAssertMode();
    else stopAssertMode();
    render();
  }

  function forwardHookEvent({ type, data }) {
    if (type === 'net-end') send({ type: 'content:event', kind: 'network', entry: { ...data, frameUrl: frame?.url } });
    else if (type === 'console') send({ type: 'content:event', kind: 'console', entry: data });
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || !d[CH] || d.dir !== 'from-page') return;
    if (d.type === 'net-start') return void inflight.add(d.data.id);
    if (d.type === 'net-end') inflight.delete(d.data.id);
    if (!known) {
      if (buffered.length < 500) buffered.push(d);
      return;
    }
    if (capturingNetwork()) forwardHookEvent(d);
  });

  // ------------------------------------------------------------ Step builder + Outcomes

  let stopOutcomeWatch = null;

  function emit(op) {
    send({ type: 'content:event', kind: 'step', op: op.op, cid: op.cid, step: op.step, screenshot: op.screenshot, screenshotDelay: op.screenshotDelay }).then((res) => {
      if (res?.counts) {
        config.counts = res.counts;
        render();
      }
    });
    const action = op.step.action;
    const committing = op.op === 'add' ? OUTCOME_ACTIONS.has(action) && action !== 'fill' : op.screenshot; // fill: on commit (blur)
    if (committing && config.settings?.captureOutcomes !== false) {
      if (stopOutcomeWatch) stopOutcomeWatch(); // attribute what we saw so far to the previous step
      const cid = op.cid;
      stopOutcomeWatch = QA.outcomes.watch((outcomes) => {
        send({ type: 'content:event', kind: 'step', op: 'update', cid, step: { outcomes }, screenshot: false });
      });
    }
  }

  const builder = QA.createStepBuilder({
    emit,
    page: () => ({ url: location.href, title: document.title, ts: Date.now(), frame: frame || undefined }),
  });

  // ------------------------------------------------------------ element facts

  function deepTarget(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.find((n) => n.nodeType === 1) || e.target;
  }
  function isTextLike(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el instanceof HTMLTextAreaElement) return true;
    return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
  }
  function isSensitive(el) {
    if (el instanceof HTMLInputElement && el.type === 'password') return true;
    if (el.getAttribute?.('autocomplete') === 'one-time-code') return true;
    const hay = [el.name, el.id, el.getAttribute?.('autocomplete'), el.getAttribute?.('aria-label'), el.placeholder].join(' ');
    return SENSITIVE_RE.test(hay) && !/user|email|login/i.test(hay);
  }
  function toggleControl(el) {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el;
    const ctl = el.closest?.('label')?.control;
    return ctl && (ctl.type === 'checkbox' || ctl.type === 'radio') ? ctl : null;
  }
  const isBody = (el) => !el || el === document.documentElement || el === document.body;
  const valueOf = (el) => (el.isContentEditable ? el.innerText : el.value);

  function interaction(type, el, facts = {}, extra = {}) {
    return { type, ref: el, describe: () => QA.sel.describe(el), facts, ...extra };
  }
  function modsOf(e) {
    const m = {};
    if (e.ctrlKey) m.ctrl = true;
    if (e.shiftKey) m.shift = true;
    if (e.altKey) m.alt = true;
    if (e.metaKey) m.meta = true;
    return Object.keys(m).length ? m : undefined;
  }

  // ------------------------------------------------------------ hover menus

  let hoverTimer = null;
  let lastHoverEl = null;

  /** Nearest ancestor (≤5 levels) that owns a popup: has aria-haspopup/expanded, or contains a menu-like container. */
  function hoverOwnerFor(el) {
    let n = el?.nodeType === 1 ? el : el?.parentElement;
    for (let depth = 0; n && n !== document.body && depth < 5; depth++, n = n.parentElement) {
      if (n.matches('[aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded]')) return n;
      const popup = n.querySelector(MENU_SELECTOR);
      if (popup && !popup.contains(el)) return n;
    }
    return null;
  }
  function onMouseOver(e) {
    if (!recording() || !e.isTrusted || config.assertMode || QA.overlay.isOverlayEvent(e)) return;
    const t = deepTarget(e);
    // Left the owner and its popup: a later hover over it is a new hover.
    if (lastHoverEl && !(lastHoverEl.parentElement || lastHoverEl).contains(t)) lastHoverEl = null;
    const owner = hoverOwnerFor(t);
    if (!owner || owner === lastHoverEl) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      lastHoverEl = owner;
      // Describe what the user points at (the "Account" button), not the whole menu container.
      const trigger = QA.sel.isInteractive(owner) ? owner : owner.querySelector('button, a[href], [role="button"], [aria-haspopup], [tabindex]') || owner;
      builder.handle({ type: 'hover', ref: owner, describe: () => QA.sel.describe(trigger) });
    }, 250);
  }
  /** The hovered element whose popup contains `el`, if `el` was revealed by hovering. */
  function revealedBy(el) {
    if (!lastHoverEl || lastHoverEl === el || el.contains(lastHoverEl)) return null;
    const menu = el.closest(MENU_SELECTOR);
    if (!menu || menu.contains(lastHoverEl)) return null;
    const scope = lastHoverEl.parentElement || lastHoverEl;
    return lastHoverEl.contains(menu) || scope.contains(menu) ? lastHoverEl : null;
  }

  // ------------------------------------------------------------ drag & drop

  let html5Drag = null;
  let pointer = null;
  let suppressClick = false;

  function onDragStart(e) {
    if (!recording() || !e.isTrusted) return;
    html5Drag = QA.sel.actionableTarget(deepTarget(e)) || deepTarget(e);
  }
  function onDrop(e) {
    if (!recording() || !e.isTrusted || !html5Drag) return;
    const target = deepTarget(e);
    builder.handle({ type: 'drag', source: interaction('x', html5Drag), target: interaction('x', target), html5: true });
    html5Drag = null;
  }
  /** The draggable *item* under the pointer (not its list container), or null. */
  function looksDraggable(el) {
    if (!el?.closest) return null;
    const native = el.closest('[draggable="true"]');
    if (native) return native;
    const grabby = (n) => /grab|move/.test(getComputedStyle(n).cursor);
    // cursor is inherited: the item is the outermost ancestor that still shows a grab/move cursor
    if (grabby(el)) {
      let n = el;
      while (n.parentElement && n.parentElement !== document.body && grabby(n.parentElement)) n = n.parentElement;
      return n;
    }
    const handle = el.closest('[class*="drag-handle" i], [class*="draggable" i], [class*="handle" i]');
    if (handle) return handle.closest('li, [role="listitem"], [role="row"], tr, [class*="item" i], [class*="card" i]') || handle;
    const list = el.closest('[class*="sortable" i], [class*="dnd" i], [class*="kanban" i], [class*="board" i]');
    if (list && list !== el) return Array.from(list.children).find((c) => c.contains(el)) || null;
    return null;
  }
  function onMouseDown(e) {
    if (!recording() || !e.isTrusted || e.button !== 0 || QA.overlay.isOverlayEvent(e)) return;
    const el = deepTarget(e);
    const src = looksDraggable(el);
    pointer = src ? { src, x: e.clientX, y: e.clientY, moved: false } : null;
  }
  function onMouseMove(e) {
    if (pointer && !pointer.moved && Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 15) pointer.moved = true;
  }
  function onMouseUp(e) {
    const p = pointer;
    pointer = null;
    if (!p || !p.moved || html5Drag || !recording()) return;
    window.getSelection?.().removeAllRanges(); // dragging often selects text as a side effect
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || p.src.contains(target)) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 100);
    builder.handle({ type: 'drag', source: interaction('x', p.src), target: interaction('x', QA.sel.actionableTarget(target) || target) });
  }

  // ------------------------------------------------------------ listeners

  function onClick(e) {
    if (!recording() || !e.isTrusted || config.assertMode || suppressClick || QA.overlay.isOverlayEvent(e)) return;
    const raw = deepTarget(e);
    const el = QA.sel.actionableTarget(raw);
    const facts = {
      // Clicks on blank areas / layout containers are not steps.
      body: isBody(el) || !QA.sel.isInteractive(el),
      textLike: isTextLike(el),
      toggle: !!toggleControl(raw),
      select: el instanceof HTMLSelectElement || el instanceof HTMLOptionElement,
      hoverOwner: el ? revealedBy(el) : null,
    };
    builder.handle(interaction('click', el, facts, { button: e.button === 2 ? 'right' : 'left', detail: e.detail, modifiers: modsOf(e) }));
  }
  function onDblClick(e) {
    if (!recording() || !e.isTrusted || config.assertMode || QA.overlay.isOverlayEvent(e)) return;
    builder.handle(interaction('dblclick', QA.sel.actionableTarget(deepTarget(e))));
  }
  function onContextMenu(e) {
    if (!recording() || !e.isTrusted || QA.overlay.isOverlayEvent(e)) return;
    const el = QA.sel.actionableTarget(deepTarget(e));
    if (el) builder.handle(interaction('click', el, { body: isBody(el) }, { button: 'right', detail: 1 }));
  }
  function onInput(e) {
    if (!recording() || !e.isTrusted) return;
    const el = deepTarget(e);
    if (!isTextLike(el)) return;
    builder.handle(interaction('input', el, { textLike: true, sensitive: isSensitive(el) }, { value: valueOf(el) }));
  }
  function onChange(e) {
    if (!recording() || !e.isTrusted) return;
    const el = deepTarget(e);
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      return builder.handle(interaction('change', el, { toggle: true, checked: el.checked }));
    }
    if (el instanceof HTMLSelectElement) {
      const sel = Array.from(el.selectedOptions);
      return builder.handle(interaction('change', el, { select: true }, { value: el.value, values: sel.map((o) => o.value), optionLabels: sel.map((o) => QA.sel.norm(o.textContent)) }));
    }
    if (el instanceof HTMLInputElement && el.type === 'file') {
      return builder.handle(interaction('change', el, { file: true }, { files: Array.from(el.files || []).map((f) => ({ name: f.name, size: f.size, type: f.type })) }));
    }
    if (isTextLike(el)) builder.handle(interaction('change', el, { textLike: true }, { value: valueOf(el) }));
  }
  function onKeyDown(e) {
    if (!e.isTrusted || QA.overlay.isOverlayEvent(e)) return;
    if (config.assertMode && e.key === 'Escape') return void send({ type: 'content:control', action: 'assertMode', on: false });
    if (!recording()) return;
    const el = deepTarget(e);
    builder.handle(
      interaction(
        'keydown',
        el,
        {
          body: isBody(el),
          textLike: isTextLike(el),
          textarea: el instanceof HTMLTextAreaElement,
          select: el instanceof HTMLSelectElement,
          combobox: el.getAttribute?.('role') === 'combobox' || !!el.getAttribute?.('aria-autocomplete') || !!el.getAttribute?.('list'),
        },
        { key: e.key, modifiers: modsOf(e) },
      ),
    );
  }
  function onFocusIn(e) {
    if (recording()) builder.handle({ type: 'focus', ref: deepTarget(e) });
  }

  // ------------------------------------------------------------ assert mode

  function proposeAssertion(el, visibleOnly) {
    if (visibleOnly) return { type: 'visible' };
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return { type: 'checked', expected: el.checked };
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return { type: 'value', expected: el.value };
    const text = QA.sel.textOf(el);
    if (text && text.length <= 150) return { type: 'text', expected: text };
    return { type: 'visible' };
  }
  function assertHover(e) {
    if (QA.overlay.isOverlayEvent(e)) return;
    const el = QA.sel.actionableTarget(deepTarget(e)) || deepTarget(e);
    const a = proposeAssertion(el, e.shiftKey);
    if (IS_TOP) QA.overlay.highlight(el, { kind: 'assert', label: `Assert ${a.type}${a.expected !== undefined ? `: "${String(a.expected).slice(0, 50)}"` : ''} · Shift = visible only · Esc = cancel` });
  }
  function assertClick(e) {
    if (!config.assertMode || QA.overlay.isOverlayEvent(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = QA.sel.actionableTarget(deepTarget(e)) || deepTarget(e);
    const assertion = proposeAssertion(el, e.shiftKey);
    builder.handle(interaction('assert', el, {}, { assertion }));
    if (IS_TOP) {
      QA.overlay.toast(`✓ Assertion added: ${assertion.type}`);
      QA.overlay.clearHighlight();
    }
  }
  function swallow(e) {
    if (config.assertMode && !QA.overlay.isOverlayEvent(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  let assertOn = false;
  function startAssertMode() {
    if (assertOn) return;
    assertOn = true;
    document.addEventListener('mousemove', assertHover, true);
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) window.addEventListener(t, swallow, true);
    window.addEventListener('click', assertClick, true);
  }
  function stopAssertMode() {
    if (!assertOn) return;
    assertOn = false;
    document.removeEventListener('mousemove', assertHover, true);
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) window.removeEventListener(t, swallow, true);
    window.removeEventListener('click', assertClick, true);
    if (IS_TOP) QA.overlay.clearHighlight();
  }

  const listen = (type, fn, target = window) => target.addEventListener(type, fn, true);
  listen('click', onClick);
  listen('dblclick', onDblClick);
  listen('contextmenu', onContextMenu);
  listen('input', onInput);
  listen('change', onChange);
  listen('keydown', onKeyDown);
  listen('focusin', onFocusIn);
  listen('mouseover', onMouseOver);
  listen('dragstart', onDragStart);
  listen('drop', onDrop);
  listen('mousedown', onMouseDown);
  listen('mousemove', onMouseMove);
  listen('mouseup', onMouseUp);

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
    const reply = (p) => {
      Promise.resolve(p)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
      return true;
    };
    switch (msg.type) {
      case 'ping':
        sendResponse({ ok: true, url: location.href, top: IS_TOP, readyState: document.readyState });
        return false;
      case 'env':
        sendResponse(environment());
        return false;
      case 'config':
        applyConfig(msg.config);
        sendResponse({ ok: true });
        return false;
      case 'overlay:visibility':
        if (IS_TOP) QA.overlay.setHidden(!msg.visible);
        sendResponse({ ok: true });
        return false;
      case 'replay:exec':
        return reply(QA.replay.exec(msg.step, msg.options));
      case 'replay:waitIdle':
        return reply(waitIdle(msg.timeoutMs || 5000));
      case 'replay:verifyOutcomes':
        return reply(QA.outcomes.verify(msg.outcomes || [], msg.timeoutMs || 3000));
      case 'replay:done':
        if (IS_TOP) QA.overlay.toast(msg.status === 'passed' ? '✅ Run passed' : msg.status === 'cancelled' ? '⏹ Run cancelled' : '❌ Run failed — see dashboard', 4000);
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  send({ type: 'content:ready', top: IS_TOP, frame }).then((c) => applyConfig(c || { mode: 'off', settings: {} }));
})();
