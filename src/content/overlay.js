// In-page UI: a small draggable recording pill, an element highlighter (used
// for assert mode and replay), and toasts. Lives in a closed shadow root so the
// app's CSS can't touch it, and the recorder ignores events coming from it.
(() => {
  const QA = (globalThis.QA = globalThis.QA || {});
  if (QA.overlay) return;

  let host = null;
  let root = null;
  let pill = null;
  let box = null;
  let tip = null;
  let hidden = false;

  const CSS = `
    :host { all: initial; }
    .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 6px;
      font: 600 12px/1 system-ui, -apple-system, Segoe UI, sans-serif; color: #fff; background: rgba(32,33,36,.92);
      border-radius: 999px; padding: 6px 6px 6px 12px; box-shadow: 0 4px 16px rgba(0,0,0,.3); user-select: none; cursor: grab; }
    .pill.hidden, .box.hidden, .tip.hidden { display: none; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #ea4335; animation: pulse 1.2s infinite; }
    .pill.paused .dot { background: #fbbc04; animation: none; }
    .pill.replay .dot { background: #4285f4; }
    .pill.assert { outline: 2px solid #34a853; }
    @keyframes pulse { 50% { opacity: .35; } }
    .label { padding-right: 4px; white-space: nowrap; }
    button { all: unset; cursor: pointer; font: 600 11px/1 system-ui, sans-serif; color: #fff; background: rgba(255,255,255,.14);
      padding: 6px 8px; border-radius: 999px; }
    button:hover { background: rgba(255,255,255,.28); }
    button.on { background: #34a853; }
    .box { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid #34a853; background: rgba(52,168,83,.12);
      border-radius: 3px; transition: all 60ms ease-out; }
    .box.replay { border-color: #4285f4; background: rgba(66,133,244,.15); }
    .box.fail { border-color: #ea4335; background: rgba(234,67,53,.15); }
    .tip { position: fixed; z-index: 2147483647; pointer-events: none; font: 500 11px/1.3 system-ui, sans-serif; color: #fff;
      background: #202124; padding: 4px 8px; border-radius: 4px; max-width: 360px; }
    .toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 2147483647; font: 500 13px/1.3 system-ui, sans-serif;
      color: #fff; background: #202124; padding: 10px 14px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
  `;

  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement('qa-recorder-overlay');
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="pill hidden" part="pill">
        <span class="dot"></span><span class="label">REC</span>
        <button data-act="pause" title="Pause / resume (Alt+Shift+P)">Pause</button>
        <button data-act="assert" title="Assert an element (Alt+Shift+A)">✓ Assert</button>
        <button data-act="screenshot" title="Evidence screenshot (Alt+Shift+S)">📷</button>
        <button data-act="stop" title="Stop">■ Stop</button>
      </div>
      <div class="box hidden"></div><div class="tip hidden"></div>`;
    pill = root.querySelector('.pill');
    box = root.querySelector('.box');
    tip = root.querySelector('.tip');
    (document.documentElement || document).appendChild(host);

    pill.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      e.stopPropagation();
      QA.overlay.onAction?.(act);
    });
    // drag to move
    let drag = null;
    pill.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = pill.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      pill.setPointerCapture(e.pointerId);
    });
    pill.addEventListener('pointermove', (e) => {
      if (!drag) return;
      pill.style.left = `${Math.max(0, e.clientX - drag.dx)}px`;
      pill.style.top = `${Math.max(0, e.clientY - drag.dy)}px`;
      pill.style.right = 'auto';
      pill.style.bottom = 'auto';
    });
    pill.addEventListener('pointerup', () => (drag = null));
  }

  function whenReady(fn) {
    if (document.documentElement) fn();
    else document.addEventListener('readystatechange', fn, { once: true });
  }

  QA.overlay = {
    onAction: null,
    isOverlayEvent(e) {
      return !!host && e.composedPath().includes(host);
    },
    render({ mode, counts, assertMode, replay, show }) {
      whenReady(() => {
        ensure();
        const visible = show && mode !== 'off';
        pill.classList.toggle('hidden', !visible || hidden);
        pill.classList.toggle('paused', mode === 'paused');
        pill.classList.toggle('replay', mode === 'replay');
        pill.classList.toggle('assert', !!assertMode);
        const label = pill.querySelector('.label');
        const btns = pill.querySelectorAll('button');
        if (mode === 'replay') {
          label.textContent = `Replaying ${(replay?.index ?? 0) + 1}/${replay?.total ?? '?'}`;
          btns.forEach((b) => (b.style.display = b.dataset.act === 'stop' ? '' : 'none'));
        } else {
          label.textContent = `${mode === 'paused' ? 'PAUSED' : 'REC'} · ${counts?.steps ?? 0} steps · ${counts?.network ?? 0} API`;
          btns.forEach((b) => (b.style.display = ''));
          pill.querySelector('[data-act="pause"]').textContent = mode === 'paused' ? 'Resume' : 'Pause';
          pill.querySelector('[data-act="assert"]').classList.toggle('on', !!assertMode);
        }
        if (!assertMode && mode !== 'replay') this.clearHighlight();
      });
    },
    setHidden(h) {
      hidden = h;
      if (pill) pill.style.visibility = h ? 'hidden' : '';
      if (box) box.style.visibility = h ? 'hidden' : '';
      if (tip) tip.style.visibility = h ? 'hidden' : '';
    },
    highlight(el, { kind = 'assert', label } = {}) {
      ensure();
      const r = el.getBoundingClientRect();
      box.className = `box ${kind}`;
      Object.assign(box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width}px`, height: `${r.height}px` });
      if (label) {
        tip.className = 'tip';
        tip.textContent = label;
        Object.assign(tip.style, { left: `${Math.max(4, r.left)}px`, top: `${r.top > 28 ? r.top - 26 : r.bottom + 6}px` });
      } else tip.className = 'tip hidden';
    },
    clearHighlight() {
      if (box) box.className = 'box hidden';
      if (tip) tip.className = 'tip hidden';
    },
    toast(text, ms = 2200) {
      whenReady(() => {
        ensure();
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = text;
        root.appendChild(t);
        setTimeout(() => t.remove(), ms);
      });
    },
  };
})();
